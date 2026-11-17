"""Tiny, dependency-free .pptx writer.

It reuses the master / layouts / theme of an existing deck (the project's
n8n-epsilon-detailed.pptx) so a new deck looks like part of the same family, and it writes only
the slide parts itself.  Colours are theme colours (accent1..6, bg1, tx1 ...), exactly like the
original deck, so changing the theme recolours everything.
"""
import re
import zipfile
from xml.sax.saxutils import escape

EMU = 914400  # per inch
W, H = 12192000, 6858000  # 13.333 x 7.5 in (16:9)

NS = (
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
)

# Layout numbers inside the template package
LAYOUT_TITLE, LAYOUT_SECTION, LAYOUT_CONTENT, LAYOUT_CLOSE = 2, 3, 4, 5

SERIF = "Cambria"
SANS = "Calibri"
MONO = "Consolas"


def inch(v):
    return int(round(v * EMU))


def _clr(c):
    """'accent2' / 'bg1' / 'tx1' -> schemeClr ; '0B1220' -> srgbClr"""
    if re.fullmatch(r"[0-9A-Fa-f]{6}", c):
        return f'<a:srgbClr val="{c.upper()}"/>'
    return f'<a:schemeClr val="{c}"/>'


def _fill(c, alpha=None):
    if c is None:
        return "<a:noFill/>"
    if alpha is None:
        return f"<a:solidFill>{_clr(c)}</a:solidFill>"
    return f'<a:solidFill><a:srgbClr val="{c}"><a:alpha val="{alpha}"/></a:srgbClr></a:solidFill>'


def _font(face):
    return (
        f'<a:latin typeface="{face}" pitchFamily="34" charset="0"/>'
        f'<a:ea typeface="{face}" pitchFamily="34" charset="-122"/>'
        f'<a:cs typeface="{face}" pitchFamily="34" charset="-120"/>'
    )


def run(text, size=14, color="accent6", bold=False, italic=False, face=SANS, spc=None):
    attrs = f'lang="en-US" sz="{int(size * 100)}"'
    if bold:
        attrs += ' b="1"'
    if italic:
        attrs += ' i="1"'
    if spc:
        attrs += f' kern="0" spc="{spc}"'
    return (
        f'<a:r><a:rPr {attrs} dirty="0">{_fill(color)}{_font(face)}</a:rPr>'
        f"<a:t>{escape(text)}</a:t></a:r>"
    )


def para(runs, align="l", line=None, space_after=0, bullet=False, indent_in=0.0, end_size=14):
    """runs: str of <a:r> xml (or list of them)."""
    if isinstance(runs, (list, tuple)):
        runs = "".join(runs)
    ppr = f'<a:pPr marL="{inch(indent_in) if bullet else 0}" indent="{-inch(indent_in) if bullet else 0}" algn="{align}">'
    if line:
        ppr += f'<a:lnSpc><a:spcPct val="{int(line * 1000)}"/></a:lnSpc>'
    if space_after:
        ppr += f'<a:spcAft><a:spcPts val="{int(space_after * 100)}"/></a:spcAft>'
    if bullet:
        ppr += '<a:buClr><a:schemeClr val="accent2"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>'
    else:
        ppr += "<a:buNone/>"
    ppr += "</a:pPr>"
    return f'<a:p>{ppr}{runs}<a:endParaRPr lang="en-US" sz="{int(end_size * 100)}" dirty="0"/></a:p>'


class Slide:
    def __init__(self, layout, name="Slide"):
        self.layout = layout
        self.name = name
        self.shapes = []
        self._id = 1
        self.notes = None

    def nid(self):
        self._id += 1
        return self._id

    # ---- placeholders (inherit position/format from the layout) --------------------------
    def placeholder(self, ptype, idx, text, size, color, bold=True, face=SERIF, spc=None, geom=None):
        i = self.nid()
        xfrm = ""
        if geom:
            x, y, w, h = geom
            xfrm = f'<a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{w}" cy="{h}"/></a:xfrm>'
        self.shapes.append(
            f'<p:sp><p:nvSpPr><p:cNvPr id="{i}" name="{ptype} {i}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
            f'<p:nvPr><p:ph type="{ptype}" idx="{idx}" hasCustomPrompt="1"/></p:nvPr></p:nvSpPr>'
            f'<p:spPr>{xfrm}</p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"/><a:lstStyle/>'
            f"{para(run(text, size, color, bold, face=face, spc=spc), end_size=size)}</p:txBody></p:sp>"
        )

    def slide_number(self):
        i = self.nid()
        self.shapes.append(
            f'<p:sp><p:nvSpPr><p:cNvPr id="{i}" name="Slide Number Placeholder {i}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
            f'<p:nvPr><p:ph type="sldNum" sz="quarter" idx="4294967295"/></p:nvPr></p:nvSpPr>'
            f'<p:spPr><a:xfrm><a:off x="11430000" y="6510528"/><a:ext cx="800000" cy="300000"/></a:xfrm>'
            f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
            f'<p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr><a:defRPr sz="1000"><a:solidFill><a:schemeClr val="accent4"/></a:solidFill>'
            f'<a:latin typeface="Calibri"/></a:defRPr></a:lvl1pPr></a:lstStyle><a:p><a:pPr algn="l"/>'
            f'<a:fld id="{{F7021451-1387-4CA6-816F-3879F97B5CBC}}" type="slidenum"><a:rPr lang="en-US" b="0"/><a:t>#</a:t></a:fld>'
            f'<a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>'
        )

    # ---- free shapes ---------------------------------------------------------------------
    def text(self, x, y, w, h, paragraphs, anchor="t", inset=0.0, name="Text"):
        """x,y,w,h in inches; paragraphs: list of para() strings."""
        i = self.nid()
        ins = inch(inset)
        self.shapes.append(
            f'<p:sp><p:nvSpPr><p:cNvPr id="{i}" name="{name} {i}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            f'<p:spPr><a:xfrm><a:off x="{inch(x)}" y="{inch(y)}"/><a:ext cx="{inch(w)}" cy="{inch(h)}"/></a:xfrm>'
            f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln/></p:spPr>'
            f'<p:txBody><a:bodyPr wrap="square" lIns="{ins}" tIns="{ins}" rIns="{ins}" bIns="{ins}" rtlCol="0" anchor="{anchor}"><a:normAutofit/></a:bodyPr>'
            f'<a:lstStyle/>{"".join(paragraphs)}</p:txBody></p:sp>'
        )

    def rect(self, x, y, w, h, fill="bg1", line=None, line_w=1.0, radius=None, shadow=False, shape=None, paragraphs=None, anchor="ctr", inset=0.1, name="Shape"):
        i = self.nid()
        prst = shape or ("roundRect" if radius is not None else "rect")
        av = "<a:avLst/>"
        if prst == "roundRect" and radius is not None:
            av = f'<a:avLst><a:gd name="adj" fmla="val {int(radius * 1000)}"/></a:avLst>'
        ln = f'<a:ln w="{int(line_w * 12700)}">{_fill(line)}<a:prstDash val="solid"/></a:ln>' if line else "<a:ln><a:noFill/></a:ln>"
        eff = (
            '<a:effectLst><a:outerShdw blurRad="127000" dist="38100" dir="5400000" algn="bl" rotWithShape="0">'
            '<a:srgbClr val="1A1F2B"><a:alpha val="18000"/></a:srgbClr></a:outerShdw></a:effectLst>'
            if shadow
            else ""
        )
        ins = inch(inset)
        body = (
            f'<p:txBody><a:bodyPr wrap="square" lIns="{ins}" tIns="{ins}" rIns="{ins}" bIns="{ins}" rtlCol="0" anchor="{anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>{"".join(paragraphs)}</p:txBody>'
            if paragraphs
            else '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody>'
        )
        self.shapes.append(
            f'<p:sp><p:nvSpPr><p:cNvPr id="{i}" name="{name} {i}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
            f'<p:spPr><a:xfrm><a:off x="{inch(x)}" y="{inch(y)}"/><a:ext cx="{inch(w)}" cy="{inch(h)}"/></a:xfrm>'
            f'<a:prstGeom prst="{prst}">{av}</a:prstGeom>{_fill(fill)}{ln}{eff}</p:spPr>{body}</p:sp>'
        )

    def card(self, x, y, w, h, accent="accent2", name="Card"):
        """White rounded card with a coloured top bar (the original deck's card style)."""
        self.rect(x, y, w, h, fill="bg1", line="accent5", line_w=1.0, radius=2.4, shadow=True, name=name)
        self.rect(x, y, w, 0.08, fill=accent, name="Card bar")

    def line(self, x1, y1, x2, y2, color="accent4", width=1.5, arrow=False, dash=None, name="Line"):
        i = self.nid()
        x, y = min(x1, x2), min(y1, y2)
        w, h = abs(x2 - x1), abs(y2 - y1)
        flip = ""
        if x2 < x1:
            flip += ' flipH="1"'
        if y2 < y1:
            flip += ' flipV="1"'
        tail = '<a:tailEnd type="triangle" w="med" len="med"/>' if arrow else ""
        d = f'<a:prstDash val="{dash}"/>' if dash else ""
        self.shapes.append(
            f'<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="{i}" name="{name} {i}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>'
            f'<p:spPr><a:xfrm{flip}><a:off x="{inch(x)}" y="{inch(y)}"/><a:ext cx="{inch(w)}" cy="{inch(h)}"/></a:xfrm>'
            f'<a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="{int(width * 12700)}">{_fill(color)}{d}{tail}</a:ln></p:spPr></p:cxnSp>'
        )

    def table(self, x, y, col_w, rows, row_h=0.4, header=True, size=11, head_fill="tx2", zebra=True, first_col_bold=False, col_colors=None):
        """rows: list of lists of str (or (str, color) / (str, color, bold)). col_w in inches."""
        i = self.nid()
        total_w = sum(col_w)
        grid = "".join(f'<a:gridCol w="{inch(c)}"/>' for c in col_w)
        trs = ""
        for ri, row in enumerate(rows):
            is_head = header and ri == 0
            tcs = ""
            for ci, cell in enumerate(row):
                color, bold = None, False
                if isinstance(cell, tuple):
                    cell, *rest = cell
                    color = rest[0] if rest else None
                    bold = rest[1] if len(rest) > 1 else False
                if is_head:
                    fill, tcol, bold = head_fill, "bg1", True
                else:
                    fill = "lt2" if (zebra and ri % 2 == 0) else "bg1"
                    tcol = color or (col_colors[ci] if col_colors and col_colors[ci] else "accent6")
                    if first_col_bold and ci == 0:
                        bold = True
                        tcol = color or "tx1"
                paras = "".join(
                    para(run(line, size, tcol, bold), end_size=size) for line in str(cell).split("\n")
                )
                edge = f'<a:solidFill>{_clr("accent5")}</a:solidFill>'
                borders = "".join(
                    f'<a:{b} w="9525"><a:solidFill>{_clr("accent5")}</a:solidFill></a:{b}>' for b in ("lnL", "lnR", "lnT", "lnB")
                )
                tcs += (
                    f'<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>{paras}</a:txBody>'
                    f'<a:tcPr marL="{inch(0.1)}" marR="{inch(0.1)}" marT="{inch(0.05)}" marB="{inch(0.05)}" anchor="ctr">'
                    f'{borders}{_fill(fill)}</a:tcPr></a:tc>'
                )
            rh = row_h[ri] if isinstance(row_h, (list, tuple)) else row_h
            trs += f'<a:tr h="{inch(rh)}">{tcs}</a:tr>'
        height = sum(row_h) if isinstance(row_h, (list, tuple)) else row_h * len(rows)
        self.shapes.append(
            f'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="{i}" name="Table {i}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>'
            f'<p:xfrm><a:off x="{inch(x)}" y="{inch(y)}"/><a:ext cx="{inch(total_w)}" cy="{inch(height)}"/></p:xfrm>'
            f'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>'
            f'<a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>{grid}</a:tblGrid>{trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
        )

    def xml(self):
        return (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<p:sld {NS}><p:cSld name="{escape(self.name)}"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
            '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
            + "".join(self.shapes)
            + "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
        )


def write_deck(template_path, out_path, slides, title="Deck", author=""):
    """Copy master/layout/theme parts from `template_path`, write `slides`."""
    src = zipfile.ZipFile(template_path)
    keep = [
        n
        for n in src.namelist()
        if not n.startswith("ppt/slides/")
        and not n.startswith("ppt/notesSlides/")
        and n not in ("[Content_Types].xml", "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels", "docProps/core.xml", "docProps/app.xml")
    ]

    # [Content_Types].xml : drop slide/notesSlide overrides, add ours
    ct = src.read("[Content_Types].xml").decode("utf-8")
    ct = re.sub(r'<Override PartName="/ppt/(slides|notesSlides)/[^"]+"[^>]*/>', "", ct)
    add = "".join(
        f'<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        for i in range(1, len(slides) + 1)
    )
    ct = ct.replace("</Types>", add + "</Types>")

    # presentation.xml : replace the slide id list
    pres = src.read("ppt/presentation.xml").decode("utf-8")
    ids = "".join(f'<p:sldId id="{255 + i}" r:id="rIdS{i}"/>' for i in range(1, len(slides) + 1))
    pres = re.sub(r"<p:sldIdLst>.*?</p:sldIdLst>", f"<p:sldIdLst>{ids}</p:sldIdLst>", pres, flags=re.S)

    rels = src.read("ppt/_rels/presentation.xml.rels").decode("utf-8")
    rels = re.sub(r'<Relationship Id="[^"]+" Type="[^"]+/slide" Target="slides/[^"]+"/>', "", rels)
    add_rels = "".join(
        f'<Relationship Id="rIdS{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{i}.xml"/>'
        for i in range(1, len(slides) + 1)
    )
    rels = rels.replace("</Relationships>", add_rels + "</Relationships>")

    core = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        f"<dc:title>{escape(title)}</dc:title><dc:creator>{escape(author)}</dc:creator>"
        "</cp:coreProperties>"
    )
    app = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
        f"<Application>Microsoft Office PowerPoint</Application><Slides>{len(slides)}</Slides></Properties>"
    )

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as out:
        out.writestr("[Content_Types].xml", ct)
        for n in keep:
            out.writestr(n, src.read(n))
        out.writestr("ppt/presentation.xml", pres)
        out.writestr("ppt/_rels/presentation.xml.rels", rels)
        out.writestr("docProps/core.xml", core)
        out.writestr("docProps/app.xml", app)
        for i, s in enumerate(slides, 1):
            out.writestr(f"ppt/slides/slide{i}.xml", s.xml())
            out.writestr(
                f"ppt/slides/_rels/slide{i}.xml.rels",
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                f'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout{s.layout}.xml"/>'
                "</Relationships>",
            )
