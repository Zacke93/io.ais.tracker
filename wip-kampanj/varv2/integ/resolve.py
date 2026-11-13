import re, sys
pat = re.compile(r'<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n', re.S)
def val(path, base=74):
    s = open(path, encoding='utf-8').read()
    def f(m):
        a, b = m.group(1), m.group(2)
        na = int(re.search(r'\| (\d+) scenarier', a).group(1)); nb = int(re.search(r'\| (\d+) scenarier', b).group(1))
        tot = na + nb - base
        # Ta beskrivningslistan från den längsta sidan och lägg till den andras unika poster
        la = re.search(r'scenarier \((.*?) …\)', a).group(1).split(', ')
        lb = re.search(r'scenarier \((.*?) …\)', b).group(1).split(', ')
        merged = la + [x for x in lb if x not in la]
        out = re.sub(r'\| \d+ scenarier \(.*? …\)', f'| {tot} scenarier ({", ".join(merged)} …)', a, count=1)
        return out
    n = len(pat.findall(s)); s = pat.sub(f, s); open(path, 'w', encoding='utf-8').write(s); print(path, 'löst', n)
def both(path, sep=''):
    s = open(path, encoding='utf-8').read()
    n = len(pat.findall(s)); s = pat.sub(lambda m: m.group(1) + sep + m.group(2), s); open(path, 'w', encoding='utf-8').write(s); print(path, 'båda', n)
if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'val': val(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 74)
    elif cmd == 'both': both(sys.argv[2], sys.argv[3].encode().decode('unicode_escape') if len(sys.argv) > 3 else '')
