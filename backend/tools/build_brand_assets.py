"""Export the authored H/M vector identity and native desktop icon formats."""
from pathlib import Path
import shutil
from PIL import Image,ImageDraw,ImageFont

ROOT=Path(__file__).resolve().parents[2]
PUBLIC=ROOT/'frontend/public/brand'
NATIVE=ROOT/'backend/client/brand'
MARK='M120 356V156L256 280L392 156V356 M120 266H392'

def build():
    PUBLIC.mkdir(parents=True,exist_ok=True);NATIVE.mkdir(parents=True,exist_ok=True)
    mark=f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="124" fill="#111318"/><path d="{MARK}" fill="none" stroke="#fff" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    lockup=f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 104" role="img" aria-label="HUAKE FUTURE MatrixCloud"><rect width="104" height="104" rx="26" fill="#111318"/><g transform="scale(.203125)"><path d="{MARK}" fill="none" stroke="#fff" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/></g><g fill="#17191e" font-family="Arial,Helvetica,sans-serif"><text x="128" y="30" font-size="20" font-weight="600" letter-spacing="3.1">HUAKE FUTURE</text><text x="124" y="83" font-size="52" font-weight="700" letter-spacing="-2">MatrixCloud</text></g></svg>'
    (PUBLIC/'mark.svg').write_text(mark,encoding='utf-8');(PUBLIC/'logo.svg').write_text(lockup,encoding='utf-8')
    def font(size,bold=False):
        for name in ([r'C:/Windows/Fonts/arialbd.ttf','/System/Library/Fonts/Supplemental/Arial Bold.ttf','DejaVuSans-Bold.ttf'] if bold else [r'C:/Windows/Fonts/arial.ttf','/System/Library/Fonts/Supplemental/Arial.ttf','DejaVuSans.ttf']):
            try:return ImageFont.truetype(name,size)
            except OSError:pass
        raise RuntimeError('Install Arial or DejaVu Sans to export brand icons')
    # Draw original geometry at 2x for antialiased raster exports.
    scale=2;im=Image.new('RGBA',(1024,1024));d=ImageDraw.Draw(im)
    d.rounded_rectangle((0,0,1023,1023),radius=216,fill='#111318')
    points=[(120,292),(120,110),(256,234),(392,110),(392,292)]
    d.line([(x*scale,y*scale) for x,y in points],fill='white',width=40*scale,joint='curve')
    for x,y in points:d.ellipse(((x-20)*scale,(y-20)*scale,(x+20)*scale,(y+20)*scale),fill='white')
    d.line((120*scale,220*scale,392*scale,220*scale),fill='white',width=24*scale)
    d.text((512,350*scale),'HUAKE FUTURE',font=font(24*scale),fill='#d8dee9',anchor='mm',stroke_width=0)
    d.text((512,402*scale),'MatrixCloud',font=font(43*scale,True),fill='white',anchor='mm')
    im.resize((512,512),Image.Resampling.LANCZOS).save(PUBLIC/'app-icon.png')
    im.resize((180,180),Image.Resampling.LANCZOS).save(PUBLIC/'apple-touch-icon.png')
    im.save(NATIVE/'matrixcloud.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
    im.save(NATIVE/'matrixcloud.icns')
    shutil.copy2(PUBLIC/'app-icon.png',NATIVE/'app-icon.png')
    print('Brand assets exported: SVG, PNG, ICO, ICNS')

if __name__=='__main__':build()
