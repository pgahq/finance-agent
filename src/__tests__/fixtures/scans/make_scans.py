# Generates the fictional scanned and handwritten packets in this folder. The PDFs are committed so the live
# reimbursement check (reimbursement_packet.live.test.ts) needs no Python. Nothing here comes from a real person or
# packet: names, amounts, and hotels are invented, and the "handwriting" is the Caveat and Kalam fonts (SIL OFL,
# https://github.com/google/fonts) with a scan simulated by rotation, blur, noise, and JPEG compression.
# Run: pip install pillow numpy; download Caveat[wght].ttf and Kalam-Regular.ttf to /tmp/fonts as Caveat.ttf and
# Kalam.ttf; python3 make_scans.py (writes next to this file). Regenerating gives the same packets with slightly
# different scan noise, so the committed PDFs are the ones the live check was run on.
import random, io
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np

random.seed(7); np.random.seed(7)
W, H = 850, 1100  # letter at 100 dpi
SANS = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 20) if __import__('os').path.exists('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf') else ImageFont.load_default()
SANS_S = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 15)
HAND = lambda size: ImageFont.truetype('/tmp/fonts/Caveat.ttf', size)
HAND2 = lambda size: ImageFont.truetype('/tmp/fonts/Kalam.ttf', size)
MONO = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', 14)

def form(payee, line, amount, date, title, hand=HAND, total=None):
    im = Image.new('L', (W, H), 255); d = ImageDraw.Draw(im)
    d.rectangle([60, 40, 790, 80], fill=30); d.text((120, 52), title, font=SANS, fill=255)
    d.rectangle([60, 80, 790, 700], outline=0, width=2)
    d.line([430, 80, 430, 700], fill=0, width=2)
    for y, lab in ((110, 'First and Last Name'), (140, 'HOST SITE'), (170, 'Date of Event')):
        d.line([60, y, 790, y], fill=0, width=1); d.text((66, y - 22), lab, font=SANS_S, fill=0)
    d.text((445, 118), 'Sample City, State', font=SANS_S, fill=0)
    d.text((445, 148), 'October 30 - November 3, 2026', font=SANS_S, fill=0)
    d.text((140, 86), payee, font=hand(34), fill=20)
    d.rectangle([60, 200, 790, 232], fill=30)
    d.text((100, 207), 'Expense Description and Date of Expense', font=SANS_S, fill=255)
    d.text((540, 207), 'Amount to Pay', font=SANS_S, fill=255)
    for y in range(232, 690, 24): d.line([60, y, 790, y], fill=0, width=1)
    d.text((70, 228), line, font=hand(30), fill=20)
    d.text((470, 228), amount, font=hand(30), fill=20)
    d.line([60, 690, 790, 690], fill=0, width=2); d.text((70, 696), 'TOTAL', font=SANS_S, fill=0)
    d.text((440, 696), '$', font=SANS_S, fill=0); d.text((520, 688), total or amount, font=hand(32), fill=20)
    d.rectangle([60, 760, 790, 800], outline=0, width=2); d.line([430, 760, 430, 800], fill=0, width=2)
    d.text((100, 764), payee, font=hand(32), fill=20); d.text((470, 764), date, font=hand(32), fill=20)
    d.text((66, 804), 'Runner Name', font=SANS_S, fill=0); d.text((436, 804), 'DATE', font=SANS_S, fill=0)
    return im

def folio(hotel, guest, nights, nightly, tax):
    im = Image.new('L', (W, H), 255); d = ImageDraw.Draw(im)
    d.text((70, 60), hotel.upper(), font=SANS, fill=40)
    d.text((70, 110), f'Guest: {guest}', font=SANS_S, fill=0)
    d.text((70, 135), 'Room: 1914   Arrive: 10/29/2026   Depart: 11/04/2026', font=SANS_S, fill=0)
    d.text((70, 190), 'DATE            DESCRIPTION                          AMOUNT', font=MONO, fill=0)
    y = 215; total = 0
    for n in range(nights):
        d.text((70, y), f'Oct {29+n if n<3 else n-2:02d} 2026   Room Charge                          ${nightly:,.2f}', font=MONO, fill=0); y += 20
        d.text((70, y), f'               Room taxes                           ${tax:,.2f}', font=MONO, fill=0); y += 20
        total += nightly + tax
    y += 20
    d.text((70, y), f'Total: ${total:,.2f}', font=SANS_S, fill=0); y += 22
    d.text((70, y), f'Payments: -${total:,.2f}   Balance: $0.00', font=SANS_S, fill=0)
    return im

def vendor(name, num, total):
    im = Image.new('L', (W, H), 255); d = ImageDraw.Draw(im)
    d.text((70, 60), name, font=SANS, fill=0)
    for i, t in enumerate(['INVOICE', f'Invoice Number: {num}', 'Invoice Date: 11/02/2026', 'Bill To: PGA of America', 'Event rental            $5,000.00', f'Amount Due: {total}', 'Payment terms: Net 30']):
        d.text((70, 120 + i * 28), t, font=SANS_S, fill=0)
    return im

def scan(im, angle=0.0, blur=0.0, noise=0, dpi_scale=1.0, contrast=1.0, shadow=False):
    im = im.rotate(angle, expand=False, fillcolor=245, resample=Image.BICUBIC)
    if dpi_scale != 1.0:
        im = im.resize((int(W * dpi_scale), int(H * dpi_scale)), Image.BILINEAR).resize((W, H), Image.BILINEAR)
    if blur: im = im.filter(ImageFilter.GaussianBlur(blur))
    a = np.array(im).astype(np.float32)
    a = 128 + (a - 128) * contrast
    if shadow:
        grad = np.linspace(0, 40, W)[None, :]; a = a - grad
    if noise: a = a + np.random.normal(0, noise, a.shape)
    a = np.clip(a, 0, 255).astype(np.uint8)
    return Image.fromarray(a, 'L')

def save_pdf(pages, path, quality=60):
    pages[0].save(path, 'PDF', save_all=True, append_images=pages[1:], resolution=100.0, quality=quality)


import os
out = os.path.dirname(os.path.abspath(__file__))
save_pdf([scan(form('Jordan P Reyes', 'Hotel room - Sample Courtyard  11/4/26', '$ 1,000.00', '11/5/26', '2026 Sample Marathon Team REIMBURSEMENT REQUEST'), 0.4, 0.6, 4),
          scan(folio('Sample Courtyard Hotel', 'Taylor Reyes', 6, 324.00, 52.57), -0.3, 0.5, 4)], f'{out}/handwritten_form_folio.pdf')
save_pdf([scan(form('Avery Lindqvist', 'Parking + tolls 11/3/26', '$ 212.40', '11/4/26', 'Expense Report', hand=HAND2), 1.6, 1.4, 14, 0.6, 0.8, True),
          scan(folio('Sample Courtyard Hotel', 'Avery Lindqvist', 3, 289.00, 41.30), -1.1, 1.3, 14, 0.6, 0.8, True)], f'{out}/degraded_form_folio.pdf', quality=35)
save_pdf([scan(form('Jordan P Reyes', 'Hotel room - Sample Courtyard  11/4/26', '$ 1,000.00', '11/5/26', '2026 Sample Marathon Team REIMBURSEMENT REQUEST'), 2.5, 2.6, 30, 0.35, 0.6, True),
          scan(folio('Sample Courtyard Hotel', 'Taylor Reyes', 6, 324.00, 52.57), -2.0, 2.4, 30, 0.35, 0.6, True)], f'{out}/severe_form_folio.pdf', quality=20)
save_pdf([scan(form('Casey M Brandt', 'Hotel room  11/4/26', '$ 7,000.00', '11/5/26', 'Team Reimbursement Request', hand=HAND), 0.3, 1.2, 8, 0.6, 0.85)], f'{out}/other_amount_form.pdf')
save_pdf([scan(vendor('Sample Event Rentals LLC', 'INV-1042', '$5,000.00'), 0.9, 1.0, 10, 0.7, 0.9, True)], f'{out}/scanned_vendor_invoice.pdf', quality=40)
