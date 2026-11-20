#!/usr/bin/env python3
"""Burn section captions into the cut demo video.

Reads <rec>/timeline.json (written by cut-video.py), finds where each section starts from the
driver's own steps, maps those raw times onto the cut timeline, renders one caption image per
section with headless Chrome, and overlays it at the top of the frame.

  python3 scripts/caption-video.py <rec-dir> [--in cut.mp4] [--out final.mp4]
"""
import html, json, os, subprocess, sys

rec = sys.argv[1]
src = sys.argv[sys.argv.index('--in') + 1] if '--in' in sys.argv else f'{rec}/cut.mp4'
out = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else f'{rec}/final.mp4'
tl = json.load(open(f'{rec}/timeline.json'))
keep, steps = tl['keep'], tl['steps']

def final_t(t):
    """Raw recording time -> time in the cut video."""
    acc = 0.0
    for a, b in keep:
        if t <= a:
            return acc
        if t <= b:
            return acc + (t - a)
        acc += b - a
    return acc

def first(pred, after=0.0):
    for a, b, s in steps:
        if a >= after and pred(s):
            return a
    raise SystemExit(f'caption anchor not found after {after:.1f}s')

is_cmd = lambda cid: (lambda s: s.get('do') == 'command' and s.get('id') == cid)
t_a = first(lambda s: s.get('do') == 'select')
t_undo = first(is_cmd('countersign.undo'), t_a)
t_b = first(lambda s: s.get('do') == 'agent', t_undo)
t_sess = first(is_cmd('countersign.openSession'), t_b)
t_c = first(lambda s: s.get('do') == 'terminal' and 'break-endpoint' in s.get('text', ''), t_sess)
t_stop = first(lambda s: s.get('do') == 'agent', t_c)
end = sum(b - a for a, b in keep)

sections = [
    (0.0, t_a, 'Countersign', 'a VS Code coding agent running on TrueForge · pallets/flask 3.1.3'),
    (t_a, t_undo, 'Task A · Inline edit', 'select code, Cmd+Alt+K, accept or reject each hunk'),
    (t_undo, t_b, 'Undo', 'Undo last change restores the file'),
    (t_b, t_sess, 'Task B · Agent mode', 'one request, no files named; the agent picks them and says why'),
    (t_sess, t_c, 'Task B · TrueForge session', 'the turns and tool calls behind that run'),
    (t_c, t_stop, 'Task C · Model failure', 'first model unreachable: 2 retries with backoff, then the next model takes over'),
    (t_stop, None, 'Stop', 'Esc cancels the TrueForge turn; nothing half-applied'),
]

caps = os.path.join(rec, 'caps')
os.makedirs(caps, exist_ok=True)
chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
inputs, chain, prev = [], [], '0:v'
for i, (a, b, title, sub) in enumerate(sections):
    page = os.path.join(caps, f'{i}.html')
    open(page, 'w').write(f'''<!doctype html><meta charset="utf-8"><style>
html,body{{margin:0;background:transparent}}
body{{display:flex;justify-content:center;padding-top:14px;font:500 26px -apple-system,"SF Pro Text",Helvetica,sans-serif}}
.pill{{background:rgba(11,15,23,.9);color:#e8edf5;border:1px solid rgba(255,255,255,.14);border-radius:14px;padding:10px 22px;box-shadow:0 6px 24px rgba(0,0,0,.35)}}
b{{color:#7ee0a0;font-weight:650;margin-right:14px}}</style>
<div class="pill"><b>{html.escape(title)}</b>{html.escape(sub)}</div>''')
    png = os.path.join(caps, f'{i}.png')
    subprocess.check_call([chrome, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                           '--default-background-color=00000000', '--window-size=1920,96', f'--screenshot={png}', f'file://{os.path.abspath(page)}'],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    inputs += ['-i', png]
    fa, fb = final_t(a), (final_t(b) if b is not None else end)
    nxt = f'v{i}'
    chain.append(f"[{prev}][{i + 1}:v]overlay=0:0:enable='between(t,{fa:.2f},{fb:.2f})'[{nxt}]")
    prev = nxt
    print(f'{fa:7.1f} - {fb:7.1f}  {title}')

subprocess.check_call(['ffmpeg', '-v', 'error', '-y', '-i', src, *inputs, '-filter_complex', ';'.join(chain), '-map', f'[{prev}]',
                       '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out])
json.dump([{'start': round(final_t(a), 1), 'end': round(final_t(b) if b is not None else end, 1), 'title': t} for a, b, t, _ in sections],
          open(os.path.join(rec, 'sections.json'), 'w'), indent=1)
print('wrote', out)
