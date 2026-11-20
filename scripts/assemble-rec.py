#!/usr/bin/env python3
"""Lay the recorder's segments back on one timeline as <rec>/raw.mov.

tools/winrec starts a new segment when macOS stops a capture on its own, and logs each segment's
start time. Each segment is held on its last frame until the next one starts, so a time in the
driver log still maps to the same moment in raw.mov. Writes <rec>/raw.json with the first
segment's start time (the timeline's zero).

  python3 scripts/assemble-rec.py <rec-dir>
"""
import json, subprocess, sys

rec = sys.argv[1]
segs = []
for line in open(f'{rec}/winrec.log'):
    p = line.split()
    if len(p) >= 3 and p[0] == 'segment':
        segs.append((p[1], float(p[2])))
if not segs:
    raise SystemExit('no segments in winrec.log')

def duration(path):
    return float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).decode().strip())

inputs, parts, gaps = [], [], []
for i, (path, start) in enumerate(segs):
    inputs += ['-i', path]
    d = duration(path)
    hold = 0.0
    if i + 1 < len(segs):
        hold = max(0.0, segs[i + 1][1] - start - d)
        gaps.append(round(hold, 2))
    parts.append(f'[{i}:v]scale=2880:1680:force_original_aspect_ratio=decrease,pad=2880:1680:(ow-iw)/2:(oh-ih)/2:color=0x0b0f17,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration={hold:.3f}[s{i}]')
chain = ';'.join(parts) + ';' + ''.join(f'[s{i}]' for i in range(len(segs))) + f'concat=n={len(segs)}:v=1:a=0[v]'
subprocess.check_call(['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', chain, '-map', '[v]',
                       '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', f'{rec}/raw.mov'])
json.dump({'start': segs[0][1], 'segments': len(segs), 'gaps': gaps}, open(f'{rec}/raw.json', 'w'))
print(f'{len(segs)} segment(s), gaps held {gaps} s -> {rec}/raw.mov')
