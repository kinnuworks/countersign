#!/usr/bin/env python3
"""Cut model waiting time out of a demo recording, never between an instruction and its diff.

The rules allow cutting model waiting time but not the span from giving an instruction to the
diff appearing. So only waits *after* a review was decided are trimmed: the agent finishing a run
(waitFor idle) and waiting for a command approval (allowCommand). Each trimmed wait keeps its first
and last KEEP seconds so the viewer sees the transition.

  python3 scripts/cut-video.py <rec-dir> [--keep 1.5] [--out final.mp4]
"""
import json, subprocess, sys
from datetime import datetime

rec = sys.argv[1]
keep = float(sys.argv[sys.argv.index('--keep') + 1]) if '--keep' in sys.argv else 1.5
out = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else f'{rec}/cut.mp4'

def ts(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()

steps = []  # (start, end, step)
cur = None
for line in open(f'{rec}/drv/log.txt'):
    parts = line.rstrip('\n').split(' ', 2)
    if len(parts) < 2:
        continue
    if parts[1] == 'start':
        cur = (ts(parts[0]), json.loads(parts[2]))
    elif cur and parts[1] in ('done', 'error'):
        steps.append((cur[0], ts(parts[0]), cur[1]))
        cur = None

first = next(s for s in steps if s[2].get('do') == 'focusPanel')
t0 = first[0] - 0.3  # the recorder starts about 0.3 s before the first scripted step
dur = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f'{rec}/raw.mov']).decode().strip())

cuts = []
for a, b, s in steps:
    if (s.get('do') == 'waitFor' and s.get('what') == 'idle') or s.get('do') in ('allowCommand', 'finish'):
        lo, hi = a - t0 + keep, b - t0 - keep
        if hi - lo > 1.0:
            cuts.append((lo, hi))
keepsegs, pos = [], 0.0
for lo, hi in sorted(cuts):
    if lo > pos:
        keepsegs.append((pos, lo))
    pos = max(pos, hi)
keepsegs.append((pos, dur))
total = sum(b - a for a, b in keepsegs)
print(f'raw {dur:.1f}s, cutting {len(cuts)} waits, final {total:.1f}s')
for a, b in cuts:
    print(f'  cut {a:7.1f} - {b:7.1f}  ({b - a:.1f}s)')

sel = '+'.join(f'between(t,{a:.3f},{b:.3f})' for a, b in keepsegs)
vf = f"select='{sel}',setpts=N/FRAME_RATE/TB,scale=1920:-2:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0b0f17"
subprocess.check_call(['ffmpeg', '-v', 'error', '-y', '-i', f'{rec}/raw.mov', '-vf', vf, '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-an', out])
# The timeline map (raw time -> final time) for captions and the scorecard.
with open(f'{rec}/timeline.json', 'w') as f:
    json.dump({'t0': t0, 'keep': keepsegs, 'steps': [(a - t0, b - t0, s) for a, b, s in steps]}, f, indent=1)
print('wrote', out)
