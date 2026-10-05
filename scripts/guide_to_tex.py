#!/usr/bin/env python3
"""Regenerate Bramble-detail sections of docs/STM32F1_Technical_Manual.tex
from docs/STM32F1_Guide.md (source of truth).

Replaces the bodies of Parts 5 (5.1-5.4), 6 (6.1-6.14), 7, 8 (8.1-8.5),
9 (9.1-9.2), 10 (10.1-10.4), 11, 12, 13, 14, 15--17 with converter output.
Idempotent: markers delimit each generated block; reruns replace them.

Usage: python3 scripts/guide_to_tex.py
Then:  pdflatex -output-directory=/tmp docs/STM32F1_Technical_Manual.tex (x2)
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GUIDE = ROOT / "docs" / "STM32F1_Guide.md"
TEX = ROOT / "docs" / "STM32F1_Technical_Manual.tex"

UNI = {'\u2192': '$\\to$', '\u2208': '$\\in$', '\u2212': '--', '\u2013': '--',
       '\u2014': '---', '\u00d7': '$\\times$', '\u2264': '$\\le$',
       '\u2265': '$\\ge$', '\u2248': '$\\approx$', '\u03bc': '$\\mu$',
       '\u2026': '...', '\u00a7': '\\S{}', '\u00b1': '$\\pm$',
       '\u2190': '$\\gets$', '\u2260': '$\\ne$', '\u00f7': '$\\div$',
       '\u0394': '$\\Delta$'}


def grab(src, pat):
    m = re.search(pat, src, re.M | re.S)
    assert m, pat
    return m.group(1).strip()


def esc_tt(inner):
    out = []
    for ch in inner:
        if ch == '\\':
            out.append('\\textbackslash{}')
        elif ch == '^':
            out.append('\\^{}')
        elif ch == '~':
            out.append('\\~{}')
        elif ch in '#%_&$':
            out.append('\\' + ch)
        else:
            out.append(ch)
    t = ''.join(out)
    for u, r in UNI.items():
        t = t.replace(u, r)
    return '\\texttt{%s}' % t


def esc_text(t):
    out = []
    for ch in t:
        if ch == '\\':
            out.append('\\textbackslash{}')
        elif ch == '^':
            out.append('\\^{}')
        elif ch == '~':
            out.append('\\~{}')
        elif ch in '#%_&$':
            out.append('\\' + ch)
        else:
            out.append(ch)
    return ''.join(out)


def fmt(t):
    codes = []

    def stash(m):
        codes.append(m.group(1).replace('\n', ' '))
        return '\x00%d\x00' % (len(codes) - 1)

    t = re.sub(r'`([^`]+)`', stash, t, flags=re.S)
    t = re.sub(r'\*\*([^*]+)\*\*',
               lambda m: '**' + m.group(1).replace('\n', ' ') + '**',
               t, flags=re.S)
    t = esc_text(t)
    for u, r in UNI.items():
        t = t.replace(u, r)
    t = t.replace('->', '$\\to$')
    t = re.sub(r'\*\*([^*]+)\*\*', r'\\textbf{\1}', t)
    for i, c in enumerate(codes):
        t = t.replace('\x00%d\x00' % i, esc_tt(c))
    return t


def conv_cell(c):
    return fmt(c.replace('\n', ' '))


def md_table_to_tex(block):
    lines = [l for l in block.strip().split('\n')
             if l.strip().startswith('|')]
    # A '|' inside a `code span` is content, not a column separator:
    # split on runs of '|' that are OUTSIDE backticks.
    def split_row(l):
        cells, cur, in_code = [], '', False
        for ch in l.strip().strip('|'):
            if ch == '`':
                in_code = not in_code
                cur += ch
            elif ch == '|' and not in_code:
                cells.append(cur)
                cur = ''
            else:
                cur += ch
        cells.append(cur)
        return [c.strip() for c in cells]

    rows = [split_row(l) for l in lines]
    rows = [r for r in rows if not all(set(c) <= set('-: ') for c in r)]
    ncol = len(rows[0])
    out = ['\\begin{center}', '\\begin{longtable}{%s}' % ('l' * ncol),
           '\\toprule',
           ' & '.join(conv_cell(c) for c in rows[0]) + ' \\\\',
           '\\midrule', '\\endhead']
    for r in rows[1:]:
        while len(r) < ncol:
            r.append('')
        out.append(' & '.join(conv_cell(c) for c in r[:ncol]) + ' \\\\')
    out += ['\\bottomrule', '\\end{longtable}', '\\end{center}']
    return '\n'.join(out)


# Box-drawing / unicode inside listings: listings+pdflatex cannot cope
# (Dimension too large). Fold to ASCII and drop anything else.
# NOTE: '+-' pairs keep column alignment but listings still measures the
# raw glyph run; a tree line is one unbreakable box, so ALSO break the
# tree into short indent + name + comment parts? No — simplest robust fix:
# replace the whole tree connector run with two ASCII chars.
LST_ASCII = {'\u2500': '-', '\u251c': '|-', '\u2502': '|', '\u2514': '`-',
             '\u2026': '...', '\u2014': '---', '\u2013': '--', '\u2192': '->',
             '\u2208': 'in', '\u2212': '-', '\u00d7': 'x', '\u00a7': 'S',
             '\u00b1': '+-'}


def clean_lst(l):
    for u, r in LST_ASCII.items():
        l = l.replace(u, r)
    l = ''.join(c if ord(c) < 128 else '?' for c in l)
    # listings measures each source line as one box: fold tree/comment
    # tails so no line exceeds ~90 columns (Dimension too large otherwise)
    if len(l) > 90 and ('|---' in l or '`---' in l or l.lstrip().startswith('|')
                         or l.lstrip().startswith('`')):
        head, sep, tail = l.partition('  ')
        l = head if not tail.strip() else head + '\n' + tail.strip()
    out = []
    for raw in l.split('\n'):
        while len(raw) > 92:
            cut = raw.rfind(' ', 0, 92)
            cut = cut if cut > 40 else 92
            out.append(raw[:cut])
            raw = '    ' + raw[cut:].lstrip()
        out.append(raw)
    return '\n'.join(out)


def md_body_to_tex(md_text):
    lines = md_text.split('\n')
    paras, cur = [], []

    def flush():
        if cur:
            paras.append(' '.join(cur))
            cur.clear()

    for l in lines:
        if (not l.strip() or l.startswith('|') or l.startswith('```')
                or l.startswith('- ') or l.startswith('  ')
                or l.startswith('#')):
            flush()
            paras.append(l)
        else:
            cur.append(l.strip())
    flush()
    out, i = [], 0
    while i < len(paras):
        l = paras[i]
        if l.strip().startswith('```'):
            lang = l.strip()[3:].strip()
            if lang in ('sh', 'bash'):
                style = 'sh'
            elif lang in ('js', 'javascript'):
                style = 'js'
            else:
                style = 'c'
            j, body = i + 1, []
            while j < len(paras) and not paras[j].strip().startswith('```'):
                body.append(clean_lst(paras[j]))
                j += 1
            out.append('\\begin{lstlisting}[style=%s]' % style)
            out.extend(body)
            out.append('\\end{lstlisting}')
            i = j + 1
            continue
        if l.strip().startswith('|'):
            tbl = []
            while i < len(paras) and paras[i].strip().startswith('|'):
                tbl.append(paras[i])
                i += 1
            out.append(md_table_to_tex('\n'.join(tbl)))
            continue
        if l.startswith('- '):
            out.append('\\begin{itemize}[leftmargin=*]')
            while i < len(paras) and paras[i].startswith('- '):
                t = fmt(paras[i][2:])
                j = i + 1
                while (j < len(paras) and paras[j].startswith('  ')
                        and paras[j].strip()):
                    t += ' ' + fmt(paras[j].strip())
                    j += 1
                out.append('\\item ' + t)
                i = j
            out.append('\\end{itemize}')
            continue
        out.append(fmt(l) if l.strip() else '')
        i += 1
    return '\n'.join(out)


SECTIONS = [
    ('s51', r'^## 5\.1 Instruction set.*?\n(.*?)(?=^## 5\.2)'),
    ('s52', r'^## 5\.2 Exception handling.*?\n(.*?)(?=^## 5\.3)'),
    ('s53', r'^## 5\.3 Timing model.*?\n(.*?)(?=^## 5\.4)'),
    ('s54', r'^## 5\.4 CPU state.*?\n(.*?)(?=^---\s*\n\n# Part 6)'),
    ('s61', r'^## 6\.1 GPIO.*?\n(.*?)(?=^## 6\.2)'),
    ('s62', r'^## 6\.2 USART.*?\n(.*?)(?=^## 6\.3)'),
    ('s63', r'^## 6\.3 SPI.*?\n(.*?)(?=^## 6\.4)'),
    ('s64', r'^## 6\.4 I2C.*?\n(.*?)(?=^## 6\.5)'),
    ('s65', r'^## 6\.5 TIM.*?\n(.*?)(?=^## 6\.6)'),
    ('s66', r'^## 6\.6 ADC.*?\n(.*?)(?=^## 6\.7)'),
    ('s67', r'^## 6\.7 DAC.*?\n(.*?)(?=^## 6\.8)'),
    ('s68', r'^## 6\.8 DMA.*?\n(.*?)(?=^## 6\.9)'),
    ('s69', r'^## 6\.9 CAN.*?\n(.*?)(?=^## 6\.10)'),
    ('s610', r'^## 6\.10 RTC.*?\n(.*?)(?=^## 6\.11)'),
    ('s611', r'^## 6\.11 FSMC.*?\n(.*?)(?=^## 6\.12)'),
    ('s612', r'^## 6\.12 USB.*?\n(.*?)(?=^## 6\.13)'),
    ('s613', r'^## 6\.13 NVIC.*?\n(.*?)(?=^## 6\.14)'),
    ('s614', r'^## 6\.14 IRQ.*?\n(.*?)(?=^---\s*\n\n# Part 7)'),
    ('s70', r'^# Part 7: Tested Firmware.*?\n(.*?)(?=^## 7\.1)'),
    ('s71', r'^## 7\.1 RP2040.*?\n(.*?)(?=^## 7\.2)'),
    ('s72', r'^## 7\.2 Demo firmwares.*?\n(.*?)(?=^## 7\.3)'),
    ('s73', r'^## 7\.3 Known divergence.*?\n(.*?)(?=^---\s*\n\n# Part 8)'),
    ('s81', r'^## 8\.1 Package layout.*?\n(.*?)(?=^## 8\.2)'),
    ('s82', r'^## 8\.2 High-level.*?\n(.*?)(?=^## 8\.3)'),
    ('s83', r'^## 8\.3 Low-level.*?\n(.*?)(?=^## 8\.4)'),
    ('s84', r'^## 8\.4 DMA API.*?\n(.*?)(?=^## 8\.5)'),
    ('s85', r'^## 8\.5 ADC.*?\n(.*?)(?=^## 8\.6)'),
    ('s86', r'^## 8\.6 Servers.*?\n(.*?)(?=^---\s*\n\n# Part 9)'),
    ('s91', r'^## 9\.1 GDB remote debugging.*?\n(.*?)(?=^## 9\.2)'),
    ('s92', r'^## 9\.2 Debug output.*?\n(.*?)(?=^---\s*\n\n# Part 10)'),
    ('s101', r'^## 10\.1 Flash images.*?\n(.*?)(?=^## 10\.2)'),
    ('s102', r'^## 10\.2 SD card.*?\n(.*?)(?=^## 10\.3)'),
    ('s103', r'^## 10\.3 Networking.*?\n(.*?)(?=^## 10\.4)'),
    ('s104', r'^## 10\.4 Multi-device.*?\n(.*?)(?=^---\s*\n\n# Part 11)'),
    ('s11', r'^# Part 11: Performance.*?\n(.*?)(?=^---\s*\n\n# Part 12)'),
    ('s12', r'^# Part 12: Design Decisions.*?\n(.*?)(?=^---\s*\n\n# Part 13)'),
    ('s13', r'^# Part 13: Repository Structure.*?\n(.*?)(?=^# Part 14)'),
    ('s14', r'^# Part 14: Version History.*?\n(.*?)(?=^# Part 15)'),
    ('s15', r'^# Part 15: External References.*?\n(.*?)(?=^---\n\n# Part 16)'),
    ('s16', r'^# Part 16: Glossary.*?\n(.*?)(?=^---\n\n# Part 17)'),
    ('s17', r'^# Part 17: Document History.*?\n(.*?)\Z'),
]

MARK_P5 = '% --- generated from docs/STM32F1_Guide.md ## 5.1--5.4'
MARK_P6 = '% --- generated from docs/STM32F1_Guide.md ## 6.1--6.14'
MARK_P7 = '% --- generated from docs/STM32F1_Guide.md Part 7'
MARK_P8 = '% --- generated from docs/STM32F1_Guide.md ## 8.1--8.6'
MARK_P9 = '% --- generated from docs/STM32F1_Guide.md ## 9.1--9.2'
MARK_P10 = '% --- generated from docs/STM32F1_Guide.md ## 10.1--10.4'
MARK_P11 = '% --- generated from docs/STM32F1_Guide.md Part 11'
MARK_P12 = '% --- generated from docs/STM32F1_Guide.md Part 12'
MARK_P13 = '% --- generated from docs/STM32F1_Guide.md Part 13'
MARK_P14 = '% --- generated from docs/STM32F1_Guide.md Part 14'
MARK_P15 = '% --- generated from docs/STM32F1_Guide.md Part 15--17 (tail)'

BLOCKS = {
    'p5': (MARK_P5,
           [('\\subsection{5.1 Instruction set}', 's51'),
            ('\\subsection{5.2 Exception handling}', 's52'),
            ('\\subsection{5.3 Timing model}', 's53'),
            ('\\subsection{5.4 CPU state reference}', 's54')]),
    'p6': (MARK_P6,
           [('\\subsection{6.1 GPIO}', 's61'),
            ('\\subsection{6.2 USART}', 's62'),
            ('\\subsection{6.3 SPI}', 's63'),
            ('\\subsection{6.4 I2C}', 's64'),
            ('\\subsection{6.5 TIM}', 's65'),
            ('\\subsection{6.6 ADC}', 's66'),
            ('\\subsection{6.7 DAC}', 's67'),
            ('\\subsection{6.8 DMA}', 's68'),
            ('\\subsection{6.9 CAN}', 's69'),
            ('\\subsection{6.10 RTC / BKP / PWR / FLASH}', 's610'),
            ('\\subsection{6.11 FSMC / SDIO}', 's611'),
            ('\\subsection{6.12 USB FS / OTG\\_FS}', 's612'),
            ('\\subsection{6.13 NVIC / SysTick / SCB / MPU / Debug}', 's613'),
            ('\\subsection{6.14 IRQ number table}', 's614')]),
    'p7': (MARK_P7,
           [('\\subsection{7.1 Test suite}', 's70'),
            ('\\subsection{7.2 RP2040/RP2350 comparison}', 's71'),
            ('\\subsection{7.3 Demo firmwares}', 's72'),
            ('\\subsection{7.4 Known divergence}', 's73')]),
    'p8': (MARK_P8,
           [('\\subsection{8.1 Package layout}', 's81'),
            ('\\subsection{8.2 High-level API}', 's82'),
            ('\\subsection{8.3 Low-level API}', 's83'),
            ('\\subsection{8.4 DMA API}', 's84'),
            ('\\subsection{8.5 ADC + TIM API}', 's85'),
            ('\\subsection{8.6 Servers and debug}', 's86')]),
    'p9': (MARK_P9,
           [('\\subsection{9.1 GDB remote debugging}', 's91'),
            ('\\subsection{9.2 Debug output and watch tools}', 's92')]),
    'p10': (MARK_P10,
            [('\\subsection{10.1 Flash images}', 's101'),
             ('\\subsection{10.2 SD card}', 's102'),
             ('\\subsection{10.3 Networking}', 's103'),
             ('\\subsection{10.4 Multi-device}', 's104')]),
    'p11': (MARK_P11, [(None, 's11')]),
    'p12': (MARK_P12, [(None, 's12')]),
    'p13': (MARK_P13, [(None, 's13')]),
    'p14': (MARK_P14,
            [('\\subsection{Version history}', 's14')]),
    'p1415': (MARK_P15,
            [('\\subsection{External references (annotated)}', 's15'),
             ('\\subsection{Glossary}', 's16'),
             ('\\subsection{Document history}', 's17')]),
}
TAIL_MARK = '% --- generated from docs/STM32F1_Guide.md Part 15--17 (tail)'


def main():
    src = GUIDE.read_text(encoding='utf-8')
    tex = TEX.read_text(encoding='utf-8')
    conv = {key: md_body_to_tex(grab(src, pat)) for key, pat in SECTIONS}
    # sanity: no raw unicode / markdown leftovers outside listings
    for key, body in conv.items():
        nov = re.sub(r'\\begin\{lstlisting\}.*?\\end\{lstlisting\}',
                     '', body, flags=re.S)
        for ch in set(re.findall(r'[^\x00-\x7F]', nov)):
            print('UNICODE-LEFT %s: %r' % (key, ch))
            sys.exit(1)
        assert '**' not in nov, key
        assert '`' not in nov, key
        for m in re.finditer(r'\\begin\{lstlisting\}.*?\\end\{lstlisting\}',
                             body, flags=re.S):
            for ch in m.group(0):
                assert ord(ch) < 128, (key, repr(ch))
    lines = tex.split('\n')

    def region_of(ls, marker_idx):
        # Generated block ends at the next Part boundary: the %=== rule
        # that OPENS the next \section{Part. (A \subsection{ after the
        # marker belongs to OUR block — heads are emitted by BLOCKS, not
        # pre-existing in the file.)
        cands = [i for i, l in enumerate(ls)
                 if i > marker_idx and l.startswith('%===')]
        assert cands, 'no boundary after marker'
        end = cands[0]
        while end > marker_idx and (
                ls[end - 1].strip() == '' or ls[end - 1].startswith('%===')):
            end -= 1
        return end

    for key in ('p1415',):
        marker, parts = BLOCKS[key]
        midx = next(i for i, l in enumerate(lines) if l.startswith(marker))
        # tail block: runs to end-of-document (minus \end{document})
        end = next(i for i, l in enumerate(lines)
                   if l.startswith('\\end{document}'))
        block = [marker]
        for head, key2 in parts:
            if head:
                block += ['', head, '', conv[key2], '']
            else:
                block += ['', conv[key2], '']
        lines[midx:end] = block

    for key in [k for k in BLOCKS if k != 'p1415']:
        marker, parts = BLOCKS[key]
        try:
            midx = next(i for i, l in enumerate(lines) if l.startswith(marker))
        except StopIteration:
            print('SKIP (marker already consumed): %s' % marker[:60])
            continue
        end = region_of(lines, midx)
        block = [marker]
        for head, key2 in parts:
            if head:
                block += ['', head, '', conv[key2], '']
            else:
                block += ['', conv[key2], '']
        lines[midx:end] = block
    TEX.write_text('\n'.join(lines), encoding='utf-8')
    print('wrote %s (%d lines)' % (TEX, len(lines)))


if __name__ == '__main__':
    main()
