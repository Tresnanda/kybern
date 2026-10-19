import json, pathlib, subprocess
out=pathlib.Path('/Users/mymac/projects/ade/previews/gpuix/handson-r5/order')
swift=pathlib.Path(__file__).with_name('strip.swift')
def strip(name,cells):
    subprocess.run(['swift',str(swift),str(out/(name+'.png')),*[str(v) for cell in cells for v in cell]],check=True)
for theme in ['dark','light']:
    for temperature in ['cold','warm']:
        cells=[]
        for variant in ['before','after']:
            folder=out/(variant+'-startup-'+theme+'-'+temperature)
            frames=json.loads((folder/'frames.json').read_text())
            first=frames[0]
            complete=next(frame for frame in frames if frame['sidebar'] and frame['content'])
            for description,frame in [('first capture',first),('both ready',complete)]:
                cells.append((f'{variant}: {description}, {frame["ms"]:.0f} ms',folder/frame['file']))
        strip('startup-'+theme+'-'+temperature+'-strip',cells)
    for reduced,motion in [('0','no-preference'),('1','reduce')]:
        strip('lightbox-'+theme+'-'+reduced+'-comparison',[(variant+' '+phase,out/f'{variant}-{theme}-{reduced}-middle-{phase}.png') for variant in ['before','after'] for phase in ['before','after']])
        strip('lightbox-'+theme+'-'+reduced+'-sequence',[(phase,out/f'after-{theme}-{reduced}-middle-{phase}.png') for phase in ['before','open','after']])
        strip('desktop-'+theme+'-'+reduced+'-sequence',[(phase,out/'desktop'/(f'{theme}-{motion}-open.png' if phase=='open' else f'{theme}-{motion}-escape-{phase}.png')) for phase in ['before','open','after']])
