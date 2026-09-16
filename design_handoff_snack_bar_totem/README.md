# Handoff: Snack Bar self-checkout totem

## Overview
An unattended self-checkout kiosk for a snack bar. A customer walks up to a portrait
totem, taps the products they want, confirms quantity, reviews the basket, picks a
payment method, pays, and gets a success or failure screen. There is no cashier, no
login, and no account. The whole session is anonymous and ends by returning to the
welcome screen.

Five screens plus one overlay:

1. Welcome (attract)
2. Add your items (product grid)
3. Confirm-item sheet (overlay on the grid — misclick guard)
4. Your basket (review + totals)
5. Pay (method choice + pay action)
6. Result (approved / declined)

## About the design files
The files in this bundle are **design references created in HTML** — a prototype of the
intended look and behavior, not production code to copy. The task is to **recreate these
designs in the target codebase's own environment** using its established patterns and
libraries. If there is no codebase yet, pick the framework best suited to a fullscreen
kiosk app and implement the designs there (see "Recommended implementation" below).

The prototype is written in a streaming component format specific to the design tool it
was authored in. Do not try to port that runtime. Read it for layout, spacing, copy,
colors, and state transitions only.

## Fidelity
**High fidelity.** Colors, type, spacing, radii, shadows, copy and interaction states are
final and should be reproduced faithfully. Every value comes from the "Organic" design
system, whose full token sheet is bundled here as `styles.css`. Use those tokens rather
than re-deriving values.

## Canvas and scale
The design is authored at a fixed **1080 × 1920 portrait** canvas — a standard kiosk
panel in portrait orientation. In the prototype that canvas is centered and uniformly
scaled to fit the preview window:

```
scale = min(viewportWidth / 1080, viewportHeight / 1920) * 0.96
transform: translate(-50%, -50%) scale(scale)   /* on a top:50%/left:50% absolute box */
```

On real kiosk hardware that is 1080 × 1920, drop the scaling and render at native size.
Keep the scale wrapper only if you need the app to be previewable on a desktop browser.
All type sizes below are **canvas pixels at 1080 × 1920**.

Corner radius on the outer frame (44px) is prototype chrome only — not part of the app.

---

## Design tokens

From `styles.css` (bundled). Reference these as CSS custom properties; do not hard-code
the hex values in components.

### Color
| Token | Value | Use |
| --- | --- | --- |
| `--color-bg` | #f5ead8 | Page ground on every screen |
| `--color-surface` | #ebddc5 | The sticky basket bar on the grid screen |
| `--color-text` | #201e1d | All primary text |
| `--color-accent` | #c67139 | Primary actions, selected borders, plus buttons |
| `--color-accent-2` | #7a8a5e | Second voice (sage) |
| `--color-divider` | color-mix(in srgb, #201e1d 16%, transparent) | Rules, minus-button outlines |

Ramps used in this design:
- Neutral: `--color-neutral-100` #f9f4ed, `-200` #eee7db, `-400` #c0b6a5, `-600` #82796a, `-700` #645c50, `-900` #2e2b25
- Accent: `--color-accent-100` #fff2eb, `-200` #ffe1d0, `-300` #ffc6a5, `-700` #8c491a, `-800` #643312
- Accent-2 (sage): `--color-accent-2-100` #f0fae1, `-200` #e1eecc, `-600` #728157, `-700` #56633f

Product-art palettes (background + stroke pairs used on product tiles):
- `accent`: bg `--color-accent-100`, stroke #8c491a
- `sage`: bg `--color-accent-2-100`, stroke #56633f
- `sand`: bg `--color-neutral-200`, stroke #645c50

### Type
- Headings: **Caprasimo** 400 (`--font-heading`)
- Body: **Figtree** 400/600/700 (`--font-body`)
- Both loaded by `styles.css` via Google Fonts. For a kiosk, **self-host both fonts** — the
  device may be offline or on a captive network.

### Radius
`--radius-sm` 8px · `--radius-md` 16px · `--radius-lg` 28px · pills `999px`.
Product tiles, payment-method rows and the confirm sheet's art block use 28px.

### Shadow
`--shadow-sm` `0 1px 2px rgba(46,43,37,.14)` ·
`--shadow-md` `0 3px 10px rgba(46,43,37,.16)` ·
`--shadow-lg` `0 12px 32px rgba(46,43,37,.22)`

### Spacing
Screen gutter is **64px** on all content screens; welcome uses **88px / 130px**.
Grid gap 26px. Basket row gap 18px.

---

## Screens

### 1. Welcome
**Purpose:** idle attract state; one tap starts a session.

Layout: full-bleed, `--color-bg`, padding 130px 88px, flex column, `justify-content:
space-between`. The entire screen is the tap target (click anywhere → `shop`).

Decoration: two circles, both `border-radius: 999px`, behind content —
740×740 `--color-accent-2-200` at top:-230 right:-190, and
660×660 `--color-accent-200` at bottom:-280 left:-220.

Top block (gap 30px):
- Pill tag "Self-checkout" — `.tag.tag-accent-2`, 26px, padding 14px 30px, self-aligned left
- H1 "Snack Bar" — Caprasimo 128px, line-height .95
- Paragraph — Figtree 40px, `--color-neutral-700`, line-height 1.35, max-width 660px:
  "Pick your items on screen, then pay by card or phone. No account needed."

Bottom block (gap 56px):
- Row (gap 34px): 138×138 circle filled `--color-accent`, `--shadow-md`, containing a
  white (`#f5ead8`) 64px Lucide "hand/touch" glyph, with a second copy of the circle
  behind it animating `tp-pulse` (2.2s ease-out infinite: scale 1 → 1.4, opacity .5 → 0).
  Beside it: "Touch to start" — Caprasimo 56px.
- Row (gap 40px), Figtree 27px `--color-neutral-700`: "Card tap", "Apple & Google Pay",
  "QR payment".

### 2. Add your items
**Purpose:** browse and select products.

Header (padding 52px 64px 24px, space-between):
- H2 "Add your items" — Caprasimo 60px
- Button "Empty basket" — `.btn.btn-ghost`, 26px, padding 18px 30px. **Disabled when the
  basket is empty.** Clears the basket in place — it does NOT end the session.

Sub-row (padding 0 64px 20px, space-between, both 27–28px `--color-neutral-700`):
- Left: "Tap a product, confirm the quantity, then pay."
- Right: live status string — last action, e.g. "Salted chips added" / "Basket emptied."
  Empty at session start.

Product grid (flex:1, `overflow-y: auto`, padding 16px 64px **250px** — the bottom
padding clears the sticky bar):
- `display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 26px`
  (the `minmax(0, 1fr)` matters — `1fr` alone lets tile content overflow the track)
- Tile (a `<button>`): flex column, gap 14px, padding 18px, min-height 344px,
  radius 28px, background `--color-neutral-100`, `--shadow-sm`, `min-width: 0`,
  `border: 3px solid transparent` → `3px solid var(--color-accent)` when that product is
  in the basket.
  - Art block: 100% × 176px, radius 16px, grid place-items center, background from the
    product's art palette; inside, a 112px 24×24-viewBox SVG at stroke-width 1.9,
    round caps/joins, stroke from the palette. **These glyphs are placeholders for real
    product photography** — swap for images at the same box size and radius.
  - Name — Caprasimo 29px, line-height 1.1, `overflow-wrap: anywhere`
  - Size — Figtree 23px `--color-neutral-700`
  - Footer row (margin-top auto, space-between): price Caprasimo 32px, and a pill badge
    22px / padding 10px 18px / radius 999px — "Add" on `--color-neutral-200` with
    `--color-neutral-700` text, or "N in basket" on `--color-accent-100` with
    `--color-accent-800` text.
- Tapping a tile opens the confirm sheet. **It never adds directly** — that was a
  deliberate change to prevent misclicks.

Sticky basket bar (absolute, left/right/bottom 0, padding 38px 64px 46px, background
`--color-surface`, `--shadow-lg`, space-between):
- Left: item count ("1 item" / "N items") 26px `--color-neutral-700`; total Caprasimo 54px
- Right: "Review & pay" — `.btn.btn-primary`, 34px, padding 30px 56px, **disabled when
  the basket is empty**

### 3. Confirm-item sheet (overlay)
**Purpose:** the misclick guard. Confirm which product and how many before it enters the
basket.

Backdrop: absolute inset 0, z-index 20, `color-mix(in srgb, #2e2b25 46%, transparent)`,
flex align-end. Clicking the backdrop cancels; clicks inside the sheet must not
propagate.

Sheet: full width, background `--color-bg`, radius 44px 44px 0 0, padding 64px 64px 56px,
flex column gap 44px, `--shadow-lg`.
- Header row (gap 40px): 220×220 art block, radius 28px, palette background, 130px glyph.
  Beside it (gap 12px): name Caprasimo 58px / line-height 1.05; size Figtree 30px
  `--color-neutral-700`; unit price Caprasimo 44px.
- Quantity row: background `--color-neutral-100`, radius `--radius-lg`, padding 26px 36px,
  space-between. Label "How many?" 32px `--color-neutral-700`. Stepper (gap 26px):
  minus = 84×84 circle, transparent, `2px solid var(--color-divider)`, glyph "−" 40px;
  count Caprasimo 44px min-width 52px centered; plus = 84×84 circle,
  `--color-accent` fill, `--color-bg` glyph "+" 44px.
  **Minimum quantity is 1** — minus clamps at 1, it does not close the sheet.
- Actions (gap 20px): "Cancel" `.btn.btn-secondary` flex 1, 32px, padding 32px;
  "Add $X.XX to basket" `.btn.btn-primary` flex 2, 34px, padding 32px — the label carries
  the **line total** (unit price × chosen quantity).
- Confirm adds `quantity` of the product to the basket, closes the sheet, resets pending
  quantity to 1, and sets the status string to "<name> added".

Touch targets in this sheet are 84px — well above the 44px minimum; keep them large,
this is a standing-height kiosk.

### 4. Your basket
**Purpose:** review, adjust quantities, see totals, proceed to pay.

Header (padding 60px 64px 20px): H2 "Your basket" Caprasimo 72px; sub "Change quantities
before you pay." 28px `--color-neutral-700`.

Lines (padding 20px 64px 0, flex column gap 18px). Each line: background
`--color-neutral-100`, radius `--radius-lg`, padding 24px 30px, flex row align-center
gap 28px, `--shadow-sm`:
- 116×116 art thumb, radius 16px, palette background, 72px glyph
- Name Caprasimo 34px; meta "$X.XX each · <size>" 24px `--color-neutral-700`
- Stepper (gap 18px): 68×68 minus (outlined) / count Caprasimo 34px / 68×68 plus (accent)
- Line total Caprasimo 36px, min-width 140px, right-aligned

Minus on the last unit **removes the line** (unlike the confirm sheet's clamp).

Empty state (only reachable by emptying the basket here): background
`--color-neutral-100`, radius `--radius-lg`, padding 72px, centered, 30px
`--color-neutral-700` — "Your basket is empty. Go back and scan or tap an item."
*(Note: this string still says "scan" — drop that word when you implement, there is no
scanner.)*

Footer (padding 36px 64px 46px, flex column gap 26px):
- Subtotal row and "Tax (8%)" row — 30px `--color-neutral-700`, space-between
- Total row — `border-top: 2px solid var(--color-divider)`, padding-top 24px, label
  Caprasimo 42px, amount Caprasimo 62px
- Actions (gap 20px): "Add more" `.btn.btn-secondary` flex 1, 32px, padding 30px →
  back to grid; "Pay $X.XX" `.btn.btn-primary` flex 2, 34px, padding 30px, disabled when
  empty → pay screen

### 5. Pay
**Purpose:** choose a payment method, then trigger the payment.

Centered column, padding 88px, gap 52px, text-align center. Decoration: 580×580
`--color-accent-2-200` circle at top:-190 left:-170.

Amount block (gap 16px): "Amount due" 32px `--color-neutral-700`; total Caprasimo 118px
line-height 1; item count 27px `--color-neutral-700`.

Method list (width 100%, max-width 800px, gap 20px):
- Label "Choose how to pay" — Caprasimo 46px, left-aligned
- Three rows, each a `<button>`: flex align-center gap 26px, padding 28px 34px, radius
  28px, background `--color-neutral-100`, `--shadow-sm`,
  `border: 3px solid transparent` → `3px solid var(--color-accent)` when selected.
  - Radio dot: 34×34 circle, `box-sizing: border-box`, `3px solid var(--color-neutral-400)`
    unselected → `3px solid var(--color-accent)` + `--color-accent` fill when selected
  - Name Caprasimo 36px (flex 1, left) · note 26px `--color-neutral-700` (right)
  - Rows: **Card** / "Credit or debit" · **Apple / Google Pay** / "Phone wallet" ·
    **QR payment** / "Scan with your bank app"

Actions (width 100%, max-width 800px, gap 20px):
- Primary: label is "Select a payment method" while nothing is chosen and the button is
  **disabled**; once a method is selected it becomes "Pay $X.XX" and is enabled.
  36px, padding 34px.
- Row (gap 20px): "Cancel" `.btn.btn-secondary` flex 1 → back to basket;
  "Simulate failure" `.btn.btn-secondary` flex 1, disabled until a method is chosen.
  Both 30px, padding 28px.

**"Simulate failure" is a test affordance, not product UI.** Keep it behind a debug flag
(env var / query param) so it never ships to a live totem.

There is no card-reader tap state in this design, by request — payment is triggered by
the on-screen button. If real hardware is added later, insert a "processing / present
your card" state between `pay` and `done`.

### 6. Result
**Purpose:** tell the customer the outcome and reset.

Centered column, padding 88px, gap 44px, text-align center.
- Status disc: 260×260 circle, `--shadow-md`, background `--color-accent-2-600` (success)
  or `--color-accent-700` (failure); inside a 140px `#f9f4ed` glyph at stroke-width 2.75 —
  check `M4 12.5l5.5 5.5L20 6.5` or cross `M6 6l12 12M18 6L6 18`
- Title Caprasimo 82px, line-height 1.02, animating `tp-rise`
  (.4s ease-out: translateY 20px → 0, opacity 0 → 1)
  - success: "Paid. Enjoy."
  - failure: "Payment declined"
- Body 32px `--color-neutral-700`, max-width 740px, line-height 1.35
  - success: "Payment went through. Take your items with you."
  - failure: "The payment was not accepted. Nothing was charged. Try again or choose
    another payment method."
- Success only — receipt card: background `--color-neutral-100`, radius `--radius-lg`,
  padding 44px 56px, flex row gap 44px, `--shadow-sm`. Left: 200×200 block,
  radius `--radius-md`, background `--color-text`, containing a 150px QR mark in
  `#f9f4ed`. **Replace that mark with a real generated QR code** pointing at the receipt
  URL for the order. Right (left-aligned, gap 10px): "Receipt on your phone" Caprasimo
  36px; "Scan this code to open it. Nothing is printed." 27px `--color-neutral-700`
  max-width 380px; "Order <code> · $X.XX" 25px `--color-neutral-600`.
- Actions (gap 20px): failure only — "Try payment again" `.btn.btn-primary` 32px padding
  28px 52px → back to pay screen (basket intact). Always — `.btn.btn-secondary` 32px,
  labelled "Done" on success and "Cancel order" on failure → ends session.
- Success only — "Returning to the start screen in a few seconds." 25px
  `--color-neutral-600`.

Order code format in the prototype: `SB-` + a random 4-digit number. Replace with the
real order reference from the payment/order service.

---

## Interactions and behavior

### Navigation
| From | Trigger | To |
| --- | --- | --- |
| welcome | tap anywhere | shop |
| shop | tap product tile | confirm sheet (overlay, shop stays mounted) |
| confirm sheet | Cancel / backdrop | shop |
| confirm sheet | Add to basket | shop, with items added |
| shop | Review & pay | review |
| review | Add more | shop |
| review | Pay | pay |
| pay | Cancel | review |
| pay | Pay (method selected) | done, result = approved |
| pay | Simulate failure (debug) | done, result = declined |
| done (failure) | Try payment again | pay, basket intact |
| done | Done / Cancel order | welcome, session reset |
| done (success) | 12s timer | welcome, session reset |

### Session reset
Clears basket, result, selected method and status string, and returns to welcome.
Cancel the pending auto-return timer on any manual navigation away from the result
screen so a stale timer can't fire mid-session.

### Animations
- `tp-pulse` — 2.2s (welcome) ease-out infinite: `scale(1)`/opacity .5 → 70%
  `scale(1.4)`/opacity 0 → 100% held. Used on the welcome touch affordance.
- `tp-rise` — .4s ease-out, `translateY(20px)` + opacity 0 → rest. Result title block.
- No page transitions between screens in the prototype. If you add them, keep them under
  200ms — kiosk users are standing.

### States to honor
- Disabled: `.btn:disabled` drops to 45% opacity (design-system behavior) — used on
  "Empty basket", "Review & pay", "Pay", "Simulate failure".
- Hover/active: come from the design system's accent ramp; on a touch kiosk hover is
  irrelevant but **press feedback matters** — keep the `:active` state.
- Focus: `:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px }`.
  Never leave the browser default.

---

## State management

All state is local to the kiosk session — nothing is persisted, nothing is user-scoped.

```ts
type Screen = 'welcome' | 'shop' | 'review' | 'pay' | 'done';
type Method = 'card' | 'wallet' | 'qr';
type Result = 'approved' | 'declined' | null;

interface SessionState {
  screen: Screen;
  cart: Record<ProductId, number>;  // productId -> quantity
  pending: ProductId | null;        // product in the confirm sheet
  pendingQty: number;               // >= 1
  method: Method | null;
  result: Result;
  orderCode: string;
  status: string;                   // last-action line on the grid screen
}
```

Derived (compute, never store): subtotal = Σ price × qty; tax = subtotal × 0.08;
total = subtotal + tax; itemCount = Σ qty.

**Tax rate 0.08 is a placeholder.** Move it to configuration, and decide with whoever owns
pricing whether prices are tax-inclusive. Also move the currency and its formatting to
config — the prototype hard-codes `$` and two decimals.

Rounding: the prototype multiplies floats. In production, hold prices as integer minor
units (cents) and round once at display time.

### Data fetching
- Products: read-only catalog. Fetch once at app start, cache locally, refresh on a
  schedule. The kiosk must keep selling if the network blips, so treat a cached catalog
  as valid.
- Order + payment: one call at "Pay". See below.

### Payment boundary
Put everything provider-specific behind one interface:

```ts
interface PaymentGateway {
  pay(amountMinor: number, method: Method, orderId: string):
    Promise<{ status: 'approved' | 'declined'; orderCode: string; receiptUrl?: string }>;
}
```

The prototype's "Pay" button resolves this instantly as approved. Swap in a real
implementation (Stripe Terminal, Adyen, SumUp, local NFC/EMV SDK) without touching the
screens. Handle three outcomes, not two: approved, declined, and **timeout / unknown** —
for unknown, show the failure screen but do not imply "nothing was charged" until you've
reconciled with the provider.

---

## Recommended implementation

If there is no existing codebase:

- **React + TypeScript + Vite**, one fullscreen route, rendered in Chrome kiosk mode
  (`--kiosk --app=<url>`). The app is a single state machine — no router needed; a
  `screen` discriminated union is enough. Consider XState if the payment states grow.
- **Styling:** import the bundled `styles.css` as-is for tokens and the `.btn` / `.tag`
  classes, then write component styles against `var(--*)`. If the codebase uses Tailwind,
  map the tokens into `theme.extend` rather than re-typing hex values.
- **Catalog as data:** a `products.ts` array of
  `{ id, name, size, priceMinor, image, artPalette }`. Nine products in the prototype;
  the grid takes any count (it scrolls).
- **Fonts:** self-host Caprasimo and Figtree. Do not rely on the Google Fonts `@import`
  in `styles.css` on kiosk hardware.

### Kiosk hardening (not covered by the design — but needed)
- Inactivity timeout → session reset (30–60s on shop/review, shorter on pay).
- Disable text selection, long-press context menu, pinch-zoom, overscroll bounce, and
  the on-screen keyboard (no text input exists in this flow).
- Prevent sleep / screensaver; auto-relaunch on crash; hide all browser chrome.
- Offline behavior: a payment call that fails mid-flight must not silently drop the
  basket — show the failure screen with the retry path.
- Log every session outcome (approved / declined / abandoned) with the order code for
  reconciliation. No personal data is collected, so keep it that way.

---

## Assets
- **No photography.** Every product image is a hand-drawn SVG glyph in a tinted box —
  explicitly a placeholder. Real product photos drop into the same 176px-tall,
  16px-radius box on the grid and the 116px thumb in the basket. The design system asks
  that content photography go through its `.washed` wrapper (desaturated, softened) —
  apply that when real photos land.
- **Icons:** Lucide, stroke-width 2.75 for interface glyphs (product glyphs use 1.9).
- **QR mark** on the success screen is a drawn stand-in for a generated QR code.
- Product glyph path data lives in the `ITEMS` array at the bottom of the prototype file
  if you want to reuse it verbatim.

## Files in this bundle
- `Totem Self-Checkout.dc.html` — the prototype. Markup and inline styles describe the
  screens; the script at the bottom holds the product data, the state machine, and all
  derived labels.
- `styles.css` — the Organic design system token sheet and component classes
  (`.btn`, `.tag`, `.card`, `.table`, focus and disabled states). Copy into the project.
- `design-system-guide.md` — the Organic design system's own guidance: direction, color
  ramp usage, type pairing, interaction-state rules, do/don't list.
