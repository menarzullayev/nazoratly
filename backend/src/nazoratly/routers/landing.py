"""Public landing page at `/` (static HTML, no scripts, no external assets, excluded from the OpenAPI document)."""

from __future__ import annotations

import base64
import hashlib

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from nazoratly import __version__

router = APIRouter(include_in_schema=False)

_CSS = """
:root{--bg:#f6f8fb;--fg:#14202e;--mute:#5a6b7d;--card:#fff;--line:#dfe6ee;--acc:#1a73e8}
@media(prefers-color-scheme:dark){:root{--bg:#0e141b;--fg:#e8eef5;--mute:#93a4b6;--card:#16202b;--line:#26343f;--acc:#6ea8fe}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:880px;margin:0 auto;padding:56px 20px 40px}
h1{font-size:clamp(2rem,6vw,3rem);margin:0 0 8px;letter-spacing:-.02em}
.lead{color:var(--mute);font-size:1.125rem;max-width:60ch;margin:0 0 28px}
.cta{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:40px}
a.btn{display:inline-block;padding:12px 20px;border-radius:10px;border:1px solid var(--line);color:var(--fg);text-decoration:none;font-weight:600}
a.btn.p{background:var(--acc);border-color:var(--acc);color:#fff}
a.btn:focus-visible{outline:3px solid var(--acc);outline-offset:2px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
.card h2{font-size:1rem;margin:0 0 6px}.card p{margin:0;color:var(--mute);font-size:.95rem}
footer{margin-top:40px;color:var(--mute);font-size:.875rem;display:flex;flex-wrap:wrap;gap:8px 18px}
footer a{color:var(--mute)}
"""
_SHA = base64.b64encode(hashlib.sha256(_CSS.encode()).digest()).decode()

# Only the inline <style> above is allowed; nothing else (scripts, images, frames) can load.
CSP = f"default-src 'none'; style-src 'sha256-{_SHA}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

_HTML = f"""<!doctype html>
<html lang="uz">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>nazoratly: o'quv markazi boshqaruvi</title>
<meta name="description" content="O'quv markazlari uchun davomat, to'lov, qarz va o'qituvchi oyligini yagona joyda yurituvchi tizim.">
<style>{_CSS}</style>
</head>
<body>
<main>
<h1>nazoratly</h1>
<p class="lead">O'quv markazi uchun davomat, to'lovlar, qarzdorlik va o'qituvchi oyligi bir joyda. Vasiylarga eslatmalar Telegram orqali, faqat siz tasdiqlagandan keyin yuboriladi.</p>
<div class="cta">
<a class="btn p" href="https://t.me/nazoratlybot">Telegram botni ochish</a>
<a class="btn" href="https://github.com/menarzullayev/nazoratly">Ochiq kod (GitHub)</a>
</div>
<section class="grid" aria-label="Imkoniyatlar">
<div class="card"><h2>Davomat va guruhlar</h2><p>Kunlik davomat, kechikish va guruh bo'yicha hisobot.</p></div>
<div class="card"><h2>To'lov va qarz</h2><p>Oylik hisoblar, qisman to'lov, chegirma va muddati o'tgan qarzlar.</p></div>
<div class="card"><h2>O'qituvchi oyligi</h2><p>Dars yoki foiz asosida hisoblash va oylik qaydnomasi.</p></div>
<div class="card"><h2>Vasiylar uchun bot</h2><p>/qarz orqali balans, rozilik asosida eslatmalar, "To'lov qildim" tugmasi.</p></div>
<div class="card"><h2>Inson nazorati</h2><p>AI yordamchi faqat o'qiydi va loyiha tayyorlaydi; yuborish uchun odam tasdiqlaydi.</p></div>
<div class="card"><h2>Ma'lumot xavfsizligi</h2><p>Markazlar ma'lumoti alohida ajratilgan, o'zgarishlar audit jurnalida saqlanadi.</p></div>
</section>
<footer>
<span>Versiya {__version__}</span>
<a href="/health">Holat (/health)</a>
<a href="/ready">Tayyorlik (/ready)</a>
</footer>
</main>
</body>
</html>
"""


@router.get("/", response_class=HTMLResponse)
async def landing() -> HTMLResponse:
    return HTMLResponse(
        _HTML, headers={"Content-Security-Policy": CSP, "Cache-Control": "public, max-age=300"}
    )
