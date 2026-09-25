// The ribbon is movi-logo.svg redrawn at half its band width. The logo's band
// measures 230 units across the left limb and 204 across the diagonals; here it
// is 115 and 102, and the footprint (383.55-1193 wide, 97.5-930.3 tall) is the
// logo's own. Simply growing the play-triangle cutout rounds its corners and
// pushes the band outward, and eroding both edges leaves the cap and fold
// creases where the fat band had them, so the mark reads as a bare outline.
// Instead every corner radius scales with the band (the cap is the limb's
// rounded end, so a thinner strip has a tighter end: 64 and 74.5 instead of
// 128 and 149), the diagonals are re-laid tangent to those corners, and the
// five face boundaries are re-hung on the new cutout corners. Scanning a 500px
// render of the silhouette at 52% height gives limb/wing runs of 62/92px
// against the logo's 126/167, with the silhouette still 444px wide.
export const loadingIndicatorMarkup = `
  <div class="movi-loader-container">
    <svg class="movi-loader-mark" viewBox="88 -186 1400 1400" fill="none" aria-hidden="true">
      <defs>
        <clipPath id="movi-loader-outline">
          <path clip-rule="evenodd" d="M383.55 161.5 A64 64 0 0 1 476.52 104.43 L1152.22 447.47 A74.5 74.5 0 0 1 1152.22 580.33 L476.52 923.37 A64 64 0 0 1 383.55 866.3 Z M498.55 230.01 L1057.75 513.9 C634.99 744.56 498.55 792.71 498.55 797.79 Z"/>
        </clipPath>
        <linearGradient id="movi-loader-bottom" gradientUnits="userSpaceOnUse" x1="432" y1="881" x2="1106" y2="531">
          <stop stop-color="#a3a3a3"/>
          <stop offset=".48" stop-color="#ededed"/>
          <stop offset="1" stop-color="#fff"/>
        </linearGradient>
        <linearGradient id="movi-loader-left" gradientUnits="userSpaceOnUse" x1="382" y1="239" x2="502" y2="750">
          <stop stop-color="#f5f5f5"/>
          <stop offset=".55" stop-color="#c4c4c4"/>
          <stop offset="1" stop-color="#929292"/>
        </linearGradient>
        <linearGradient id="movi-loader-fold" gradientUnits="userSpaceOnUse" x1="404" y1="838" x2="464" y2="932">
          <stop stop-color="#777"/>
          <stop offset=".55" stop-color="#c6c6c6"/>
          <stop offset="1" stop-color="#eee"/>
        </linearGradient>
        <linearGradient id="movi-loader-top" gradientUnits="userSpaceOnUse" x1="546" y1="180" x2="977" y2="554">
          <stop stop-color="#fff"/>
          <stop offset=".55" stop-color="#f4f4f4"/>
          <stop offset="1" stop-color="#b0b0b0"/>
        </linearGradient>
        <linearGradient id="movi-loader-cap" gradientUnits="userSpaceOnUse" x1="402" y1="104" x2="487" y2="230">
          <stop stop-color="#c0c0c0"/>
          <stop offset=".55" stop-color="#eee"/>
          <stop offset="1" stop-color="#fff"/>
        </linearGradient>
        <filter id="movi-loader-goo" filterUnits="userSpaceOnUse" x="300" y="40" width="970" height="950" color-interpolation-filters="sRGB">
          <feGaussianBlur stdDeviation="30"/>
          <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7"/>
        </filter>
        <mask id="movi-loader-flow-mask" maskUnits="userSpaceOnUse" x="350" y="80" width="870" height="870">
          <g filter="url(#movi-loader-goo)">
            <path class="movi-loader-flow" d="M441.05 183.62 Q441.05 143.62 476.72 161.73 L1139.97 498.51 Q1170.28 513.9 1139.97 529.29 L476.72 866.07 Q441.05 884.18 441.05 844.18 Z"/>
          </g>
        </mask>
        <g id="movi-loader-ribbon">
          <path fill="url(#movi-loader-bottom)" d="M350 80 H1220 V950 H350 Z"/>
          <path fill="url(#movi-loader-left)" d="M350 80 H498.55 V797.79 C388.8 844.92 389.45 870.99 363.55 874.28 H350 Z"/>
          <path fill="url(#movi-loader-fold)" d="M363.55 874.28 C389.45 870.99 388.8 844.92 498.55 797.79 C492.43 863.47 439.4 917.35 421.55 937.34 L350 960 V874.28 Z"/>
          <path fill="url(#movi-loader-top)" d="M350 80 H1220 V532.9 L1194.65 532.9 C1144.09 573.79 1108.59 539.97 1057.75 513.9 L498.55 230.01 C467.3 210.99 387.05 188.44 363.55 155.36 L350 155.36 Z"/>
          <path fill="url(#movi-loader-cap)" d="M350 80 H457.05 L457.05 92.94 C473.47 104.38 493.8 120.01 497.3 164.47 C498.55 178.08 498.15 203.34 498.55 230.01 C467.3 210.99 387.05 188.44 363.55 155.36 L350 155.36 Z"/>
        </g>
      </defs>
      <g clip-path="url(#movi-loader-outline)">
        <use class="movi-loader-track" href="#movi-loader-ribbon"/>
        <use class="movi-loader-highlight" href="#movi-loader-ribbon" mask="url(#movi-loader-flow-mask)"/>
      </g>
    </svg>
  </div>
`;

// Shared with Document PiP, whose markup lives in a different document.
export const loadingIndicatorStyles = `
  .movi-loader-container {
    width: 68px;
    height: 68px;
    display: inline-block;
    color: #fff;
    position: relative;
    /* The tight edge keeps the white ribbon readable over bright footage. */
    filter: drop-shadow(0 0 1px rgba(0, 0, 0, .55))
      drop-shadow(0 1px 1px rgba(0, 0, 0, .4))
      drop-shadow(0 2px 8px rgba(0, 0, 0, .35));
    animation: movi-loader-in 240ms cubic-bezier(.2, .8, .2, 1) both;
  }

  .movi-loader-mark {
    width: 100%;
    height: 100%;
    display: block;
    /* Sat where the centre play button's triangle sits, not where the box's
       middle is. That button nudges its glyph right — a triangle centred by its
       box reads as leaning left — and this mark has to land on the triangle it
       stands in for, or the ring-to-play swap slides sideways.

       Measured, mark silhouette against triangle ink, both from the canvas
       centre: the old numbers put this 1.4px right of the triangle at 375,
       2.6px at 700 and 2.9px at 1440. They were derived from a nudge the
       button no longer has — it used to be a flat 2.75px there, which was a
       proportion written as a constant, so it was only ever right at one size.

       The triangle's ink now sits at 3.74% of the button's width right of
       centre, at every width. This is that, off the button's own size
       expression — clamp(96px, 10cqw, 112px) — so the two track together
       rather than being tuned to each other once. The two bands below take
       over where the button steps out of that clamp, and each is the exact
       figure for the button size that band pins. On the mark rather than the
       container, which the arrival animation already owns. */
    transform: translateX(clamp(3.59px, 0.374cqw, 4.19px));
  }

  /* A single full-width stroke keeps the white current continuous. Separate
     crest and neck strokes left a pinched notch that read as a gap at the
     loader's actual size. Overscan keeps the band filled around its corners. */
  .movi-loader-flow {
    fill: none;
    stroke: #fff;
    stroke-linecap: round;
    stroke-width: 180;
    animation: movi-loader-flow 3s linear infinite;
  }

  /* One 3s lap sampled at 60 intervals. The tail advances 2305.92 units;
     length is 760 + 65 sin(6 pi t) + 40 sin(6 pi t - .6). This preserves
     the rolling front's motion without a separate head. Its velocity stays
     positive even at the conservative bound 2305.92 - 6 pi (65 + 40), so
     neither edge reverses. Whole cycles keep the loop seam invisible. */
  .movi-loader-track { opacity: .32; }

  @keyframes movi-loader-in {
    from { opacity: 0; transform: scale(.84); }
    to { opacity: 1; transform: none; }
  }

  /* Use actual path units: WebKit does not consistently apply pathLength to
     dashes. One full perimeter per cycle also keeps the loop seam invisible.
     The flow path is the thin band's centre line, whose perimeter is 2305.92.
     See the generated-curves note above for what each of these traces. */
  @keyframes movi-loader-flow {
    0% { stroke-dasharray: 737.41 1568.51; stroke-dashoffset: -0.00; }
    1.667% { stroke-dasharray: 768.81 1537.11; stroke-dashoffset: -38.43; }
    3.333% { stroke-dasharray: 799.34 1506.58; stroke-dashoffset: -76.86; }
    5% { stroke-dasharray: 826.02 1479.90; stroke-dashoffset: -115.30; }
    6.667% { stroke-dasharray: 846.24 1459.68; stroke-dashoffset: -153.73; }
    8.333% { stroke-dasharray: 858.01 1447.91; stroke-dashoffset: -192.16; }
    10% { stroke-dasharray: 860.20 1445.72; stroke-dashoffset: -230.59; }
    11.667% { stroke-dasharray: 852.57 1453.35; stroke-dashoffset: -269.02; }
    13.333% { stroke-dasharray: 835.88 1470.04; stroke-dashoffset: -307.46; }
    15% { stroke-dasharray: 811.77 1494.15; stroke-dashoffset: -345.89; }
    16.667% { stroke-dasharray: 782.59 1523.33; stroke-dashoffset: -384.32; }
    18.333% { stroke-dasharray: 751.19 1554.73; stroke-dashoffset: -422.75; }
    20% { stroke-dasharray: 720.66 1585.26; stroke-dashoffset: -461.18; }
    21.667% { stroke-dasharray: 693.98 1611.94; stroke-dashoffset: -499.62; }
    23.333% { stroke-dasharray: 673.76 1632.16; stroke-dashoffset: -538.05; }
    25% { stroke-dasharray: 661.99 1643.93; stroke-dashoffset: -576.48; }
    26.667% { stroke-dasharray: 659.80 1646.12; stroke-dashoffset: -614.91; }
    28.333% { stroke-dasharray: 667.43 1638.49; stroke-dashoffset: -653.34; }
    30% { stroke-dasharray: 684.12 1621.80; stroke-dashoffset: -691.78; }
    31.667% { stroke-dasharray: 708.23 1597.69; stroke-dashoffset: -730.21; }
    33.333% { stroke-dasharray: 737.41 1568.51; stroke-dashoffset: -768.64; }
    35% { stroke-dasharray: 768.81 1537.11; stroke-dashoffset: -807.07; }
    36.667% { stroke-dasharray: 799.34 1506.58; stroke-dashoffset: -845.50; }
    38.333% { stroke-dasharray: 826.02 1479.90; stroke-dashoffset: -883.94; }
    40% { stroke-dasharray: 846.24 1459.68; stroke-dashoffset: -922.37; }
    41.667% { stroke-dasharray: 858.01 1447.91; stroke-dashoffset: -960.80; }
    43.333% { stroke-dasharray: 860.20 1445.72; stroke-dashoffset: -999.23; }
    45% { stroke-dasharray: 852.57 1453.35; stroke-dashoffset: -1037.66; }
    46.667% { stroke-dasharray: 835.88 1470.04; stroke-dashoffset: -1076.10; }
    48.333% { stroke-dasharray: 811.77 1494.15; stroke-dashoffset: -1114.53; }
    50% { stroke-dasharray: 782.59 1523.33; stroke-dashoffset: -1152.96; }
    51.667% { stroke-dasharray: 751.19 1554.73; stroke-dashoffset: -1191.39; }
    53.333% { stroke-dasharray: 720.66 1585.26; stroke-dashoffset: -1229.82; }
    55% { stroke-dasharray: 693.98 1611.94; stroke-dashoffset: -1268.26; }
    56.667% { stroke-dasharray: 673.76 1632.16; stroke-dashoffset: -1306.69; }
    58.333% { stroke-dasharray: 661.99 1643.93; stroke-dashoffset: -1345.12; }
    60% { stroke-dasharray: 659.80 1646.12; stroke-dashoffset: -1383.55; }
    61.667% { stroke-dasharray: 667.43 1638.49; stroke-dashoffset: -1421.98; }
    63.333% { stroke-dasharray: 684.12 1621.80; stroke-dashoffset: -1460.42; }
    65% { stroke-dasharray: 708.23 1597.69; stroke-dashoffset: -1498.85; }
    66.667% { stroke-dasharray: 737.41 1568.51; stroke-dashoffset: -1537.28; }
    68.333% { stroke-dasharray: 768.81 1537.11; stroke-dashoffset: -1575.71; }
    70% { stroke-dasharray: 799.34 1506.58; stroke-dashoffset: -1614.14; }
    71.667% { stroke-dasharray: 826.02 1479.90; stroke-dashoffset: -1652.58; }
    73.333% { stroke-dasharray: 846.24 1459.68; stroke-dashoffset: -1691.01; }
    75% { stroke-dasharray: 858.01 1447.91; stroke-dashoffset: -1729.44; }
    76.667% { stroke-dasharray: 860.20 1445.72; stroke-dashoffset: -1767.87; }
    78.333% { stroke-dasharray: 852.57 1453.35; stroke-dashoffset: -1806.30; }
    80% { stroke-dasharray: 835.88 1470.04; stroke-dashoffset: -1844.74; }
    81.667% { stroke-dasharray: 811.77 1494.15; stroke-dashoffset: -1883.17; }
    83.333% { stroke-dasharray: 782.59 1523.33; stroke-dashoffset: -1921.60; }
    85% { stroke-dasharray: 751.19 1554.73; stroke-dashoffset: -1960.03; }
    86.667% { stroke-dasharray: 720.66 1585.26; stroke-dashoffset: -1998.46; }
    88.333% { stroke-dasharray: 693.98 1611.94; stroke-dashoffset: -2036.90; }
    90% { stroke-dasharray: 673.76 1632.16; stroke-dashoffset: -2075.33; }
    91.667% { stroke-dasharray: 661.99 1643.93; stroke-dashoffset: -2113.76; }
    93.333% { stroke-dasharray: 659.80 1646.12; stroke-dashoffset: -2152.19; }
    95% { stroke-dasharray: 667.43 1638.49; stroke-dashoffset: -2190.62; }
    96.667% { stroke-dasharray: 684.12 1621.80; stroke-dashoffset: -2229.06; }
    98.333% { stroke-dasharray: 708.23 1597.69; stroke-dashoffset: -2267.49; }
    100% { stroke-dasharray: 737.41 1568.51; stroke-dashoffset: -2305.92; }
  }

  @media (prefers-reduced-motion: reduce) {
    .movi-loader-container { animation: none; }
    .movi-loader-flow { animation: none; }
    .movi-loader-track { opacity: 1; }
    .movi-loader-highlight { display: none; }
  }

  @container movi-host (max-width: 720px) {
    .movi-loader-container { width: 52px; height: 52px; }
    /* The button is pinned to the clamp's 96px floor for this whole band (10cqw
       cannot reach it under 720), and its glyph is smaller here than at the
       same 96px above the breakpoint — so the triangle lands at 3.48px, not the
       3.59px the base clamp would give. */
    .movi-loader-mark { transform: translateX(3.48px); }
  }

  /* The button steps out of its clamp here — 72px — so the nudge that follows
     it has to step too, or the spinner lands a pixel and a half right of the
     triangle it stands in for. A viewport query, deliberately: it is the pin on
     the button that this tracks, and that pin is a viewport query too. Last in
     the file so it wins over the container band above, which it overlaps. */
  @media (max-width: 480px) {
    .movi-loader-mark { transform: translateX(2.64px); }
  }
`;
