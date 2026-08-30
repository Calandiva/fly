# -*- coding: utf-8 -*-
"""Fly 빌드 — src/* 를 의존성 없는 단일 HTML 로 묶는다.

  index.html  GitHub Pages / Vercel / 로컬 file:// 용 완전한 문서
  fly.html    Artifact 배포용 (호스트가 doctype/head/body 로 감싼다)

카메라와 방향 센서는 https 또는 localhost 에서만 동작한다. file:// 로 열면
데모 모드와 드래그 둘러보기까지만 확인할 수 있다.
"""
import io, os, sys, hashlib, datetime

SRC = 'src'
JS = ['20-geo.js', '25-catalog.js', '30-orient.js', '32-sensors.js',
      '35-track.js', '40-source.js', '42-route.js', '45-demo.js', '50-render.js', '60-ui.js',
      '80-app.js', '99-boot.js']

DESC = ('휴대폰을 하늘로 들면 카메라 위에 지금 지나가는 항공기가 '
        '편명·고도·거리와 함께 겹쳐 보이는 증강현실 레이더.')


def rd(name):
    return io.open(os.path.join(SRC, name), encoding='utf-8').read()


def wr(path, text):
    io.open(path, 'w', encoding='utf-8', newline='\n').write(text)


def build_stamp(js):
    """배포된 것이 어느 빌드인지 화면에서 보이게 하려고 박아 넣는다.

    커밋 해시를 쓰면 늘 한 발 뒤처진다 — 빌드가 커밋보다 먼저이기 때문.
    번들 내용의 해시를 쓰면 배포된 페이지와 소스가 같은지 바로 대조된다.
    """
    when = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
    digest = hashlib.sha256(js.encode('utf-8')).hexdigest()[:8]
    return when + ' ' + digest


def main():
    head = rd('00-head.htmlpart')
    body = rd('10-body.htmlpart')
    js = '\n'.join(rd(n) for n in JS)
    js = js.replace('__BUILD__', build_stamp(js))

    wr('fly.bundle.js', js)

    # 1) 아티팩트용 — head 조각과 body 조각을 이어 붙이기만 한다
    art = head + '\n' + body + '\n<script>\n' + js + '\n</script>\n'
    wr('fly.html', art)

    # 2) 완전한 문서 — head 조각의 <meta charset> 은 문서 head 로 옮긴다
    page = (
        '<!doctype html>\n<html lang="ko">\n<head>\n'
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1,'
        'maximum-scale=1,viewport-fit=cover">\n'
        '<meta name="description" content="' + DESC + '">\n'
        '<meta name="color-scheme" content="dark">\n'
        '<meta name="theme-color" content="#050908">\n'
        '<meta name="mobile-web-app-capable" content="yes">\n'
        '<meta name="apple-mobile-web-app-capable" content="yes">\n'
        '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n'
        + head.replace('<meta charset="utf-8">\n', '', 1) +
        '\n</head>\n<body>\n' + body + '\n<script>\n' + js + '\n</script>\n'
        '</body>\n</html>\n'
    )
    wr('index.html', page)

    wr('.nojekyll', '')
    wr('vercel.json', '{\n  "cleanUrls": true,\n  "trailingSlash": false\n}\n')

    kb = lambda s: len(s.encode('utf-8')) / 1024.0
    print('index.html  %7.1f KB   (Pages / Vercel / file:// 로컬)' % kb(page))
    print('fly.html    %7.1f KB   (Artifact 배포용)' % kb(art))
    print('bundle js   %7.1f KB   (%d 파일)' % (kb(js), len(JS)))
    print('빌드 표시   %s' % js[js.index("var BUILD = '") + 13:].split("'")[0])


if __name__ == '__main__':
    sys.exit(main())
