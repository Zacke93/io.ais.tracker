import re, sys
pat = re.compile(r'<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n', re.S)
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
k = [0]
def fix(m):
    a, b = m.group(1), m.group(2); k[0] += 1; i = k[0]
    if i == 1:
        return a + '    },\n  },\n' + b
    if i == 2:
        assert 'truthPaths' in a and 'samples };' in b
        return ('    return {\n      result: JSON.parse(m[1]), sampleCount: samples.length, truthPaths, samples,\n    };\n')
    if i == 3:
        al = a.rstrip('\n').split('\n'); bl = b.rstrip('\n').split('\n')
        assert al[-1].startswith('function checkExpectations') and bl[-1].startswith('function checkExpectations')
        return '\n'.join(al[:-1]) + '\n' + '\n'.join(bl[:-1]) + '\nfunction checkExpectations(scenario, result, truthPaths = {}, samples = []) {\n'
    if i == 4:
        return ('    const {\n      result, sampleCount, truthPaths, samples,\n    } = runScenario(scenario);\n'
                '    const problems = checkExpectations(scenario, result, truthPaths, samples);\n')
    raise SystemExit('oväntat block %d' % i)
s = pat.sub(fix, s)
open(p, 'w', encoding='utf-8').write(s)
print('löst', k[0])
