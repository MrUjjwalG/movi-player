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
            <path class="movi-loader-neck" d="M441.05 183.62 Q441.05 143.62 476.72 161.73 L1139.97 498.51 Q1170.28 513.9 1139.97 529.29 L476.72 866.07 Q441.05 884.18 441.05 844.18 Z"/>
            <path class="movi-loader-crest" d="M441.05 183.62 Q441.05 143.62 476.72 161.73 L1139.97 498.51 Q1170.28 513.9 1139.97 529.29 L476.72 866.07 Q441.05 884.18 441.05 844.18 Z"/>
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

  /* The light is water coming in like a tide: one body that keeps moving,
     its tail at a steady pace, its head surging ahead and drawing back three
     times a lap — and at the top of each surge a crest runs out in front of
     it, held to the body by a narrower neck, and falls back in as the water
     draws back. It thins; it never breaks. All three are dashes on the band's
     centre line; the round caps, cut to the band by the outline, are the
     rounded front of the water.

     The neck is drawn, not left to the filter. A goo filter (blur, then a
     steep alpha threshold) can hold a bridge between two blobs, but measured
     on this band it goes from 86% of the band's width to nothing between a
     gap of 200 and 220 — a knife edge that another size or engine would tip
     into a break. So the neck is its own 50-wide stroke (the band is 115;
     the filter's blur rounds it out to about 70, some 60% of the band)
     from the head to the crest, always there while they are apart, and the
     filter only rounds the joins into a fluid shape. Without the filter the
     shapes are still joined.

     180 wide for the body and the crest: over the band with room for the
     blur, so the water fills the band edge to edge, round the corners too. */
  .movi-loader-flow,
  .movi-loader-crest,
  .movi-loader-neck {
    fill: none;
    stroke: #fff;
    stroke-linecap: round;
  }
  .movi-loader-flow,
  .movi-loader-crest {
    stroke-width: 180;
  }
  .movi-loader-neck {
    stroke-width: 50;
  }

  /* Generated, not hand-tuned: one 3s lap sampled every 1/60th. The tail
     moves 2305.92 (the perimeter) a lap at a constant speed. The body's length
     is 480 + 160 sin(3 x 2 pi t) — three surges a lap, and fast enough that
     the head actually runs back a little on each ebb. The crest sits
     100 + 230 sin(3 x 2 pi t - 0.6) past the head: out to 330 just after
     each surge peaks, back inside the body (negative) on the ebb. It has to
     get that far for a neck to show at all: the head's and the crest's round
     caps each reach 90 past their dashes, so at a gap under 180 they touch.
     The neck spans head to crest, 20 longer so it overlaps both. Every curve has a whole
     number of cycles per lap, so 0% and 100% are the same picture. */
  .movi-loader-flow { animation: movi-loader-flow 3s linear infinite; }
  .movi-loader-crest {
    stroke-dasharray: 40 2265.92;
    animation: movi-loader-crest 3s linear infinite;
  }
  .movi-loader-neck { animation: movi-loader-neck 3s linear infinite; }

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
    0% { stroke-dasharray: 480.00 1825.92; stroke-dashoffset: 0; }
    1.667% { stroke-dasharray: 529.44 1776.48; stroke-dashoffset: -38.43; }
    3.333% { stroke-dasharray: 574.05 1731.87; stroke-dashoffset: -76.86; }
    5% { stroke-dasharray: 609.44 1696.48; stroke-dashoffset: -115.30; }
    6.667% { stroke-dasharray: 632.17 1673.75; stroke-dashoffset: -153.73; }
    8.333% { stroke-dasharray: 640.00 1665.92; stroke-dashoffset: -192.16; }
    10% { stroke-dasharray: 632.17 1673.75; stroke-dashoffset: -230.59; }
    11.67% { stroke-dasharray: 609.44 1696.48; stroke-dashoffset: -269.02; }
    13.33% { stroke-dasharray: 574.05 1731.87; stroke-dashoffset: -307.46; }
    15% { stroke-dasharray: 529.44 1776.48; stroke-dashoffset: -345.89; }
    16.67% { stroke-dasharray: 480.00 1825.92; stroke-dashoffset: -384.32; }
    18.33% { stroke-dasharray: 430.56 1875.36; stroke-dashoffset: -422.75; }
    20% { stroke-dasharray: 385.95 1919.97; stroke-dashoffset: -461.18; }
    21.67% { stroke-dasharray: 350.56 1955.36; stroke-dashoffset: -499.62; }
    23.33% { stroke-dasharray: 327.83 1978.09; stroke-dashoffset: -538.05; }
    25% { stroke-dasharray: 320.00 1985.92; stroke-dashoffset: -576.48; }
    26.67% { stroke-dasharray: 327.83 1978.09; stroke-dashoffset: -614.91; }
    28.33% { stroke-dasharray: 350.56 1955.36; stroke-dashoffset: -653.34; }
    30% { stroke-dasharray: 385.95 1919.97; stroke-dashoffset: -691.78; }
    31.67% { stroke-dasharray: 430.56 1875.36; stroke-dashoffset: -730.21; }
    33.33% { stroke-dasharray: 480.00 1825.92; stroke-dashoffset: -768.64; }
    35% { stroke-dasharray: 529.44 1776.48; stroke-dashoffset: -807.07; }
    36.67% { stroke-dasharray: 574.05 1731.87; stroke-dashoffset: -845.50; }
    38.33% { stroke-dasharray: 609.44 1696.48; stroke-dashoffset: -883.94; }
    40% { stroke-dasharray: 632.17 1673.75; stroke-dashoffset: -922.37; }
    41.67% { stroke-dasharray: 640.00 1665.92; stroke-dashoffset: -960.80; }
    43.33% { stroke-dasharray: 632.17 1673.75; stroke-dashoffset: -999.23; }
    45% { stroke-dasharray: 609.44 1696.48; stroke-dashoffset: -1037.66; }
    46.67% { stroke-dasharray: 574.05 1731.87; stroke-dashoffset: -1076.10; }
    48.33% { stroke-dasharray: 529.44 1776.48; stroke-dashoffset: -1114.53; }
    50% { stroke-dasharray: 480.00 1825.92; stroke-dashoffset: -1152.96; }
    51.67% { stroke-dasharray: 430.56 1875.36; stroke-dashoffset: -1191.39; }
    53.33% { stroke-dasharray: 385.95 1919.97; stroke-dashoffset: -1229.82; }
    55% { stroke-dasharray: 350.56 1955.36; stroke-dashoffset: -1268.26; }
    56.67% { stroke-dasharray: 327.83 1978.09; stroke-dashoffset: -1306.69; }
    58.33% { stroke-dasharray: 320.00 1985.92; stroke-dashoffset: -1345.12; }
    60% { stroke-dasharray: 327.83 1978.09; stroke-dashoffset: -1383.55; }
    61.67% { stroke-dasharray: 350.56 1955.36; stroke-dashoffset: -1421.98; }
    63.33% { stroke-dasharray: 385.95 1919.97; stroke-dashoffset: -1460.42; }
    65% { stroke-dasharray: 430.56 1875.36; stroke-dashoffset: -1498.85; }
    66.67% { stroke-dasharray: 480.00 1825.92; stroke-dashoffset: -1537.28; }
    68.33% { stroke-dasharray: 529.44 1776.48; stroke-dashoffset: -1575.71; }
    70% { stroke-dasharray: 574.05 1731.87; stroke-dashoffset: -1614.14; }
    71.67% { stroke-dasharray: 609.44 1696.48; stroke-dashoffset: -1652.58; }
    73.33% { stroke-dasharray: 632.17 1673.75; stroke-dashoffset: -1691.01; }
    75% { stroke-dasharray: 640.00 1665.92; stroke-dashoffset: -1729.44; }
    76.67% { stroke-dasharray: 632.17 1673.75; stroke-dashoffset: -1767.87; }
    78.33% { stroke-dasharray: 609.44 1696.48; stroke-dashoffset: -1806.30; }
    80% { stroke-dasharray: 574.05 1731.87; stroke-dashoffset: -1844.74; }
    81.67% { stroke-dasharray: 529.44 1776.48; stroke-dashoffset: -1883.17; }
    83.33% { stroke-dasharray: 480.00 1825.92; stroke-dashoffset: -1921.60; }
    85% { stroke-dasharray: 430.56 1875.36; stroke-dashoffset: -1960.03; }
    86.67% { stroke-dasharray: 385.95 1919.97; stroke-dashoffset: -1998.46; }
    88.33% { stroke-dasharray: 350.56 1955.36; stroke-dashoffset: -2036.90; }
    90% { stroke-dasharray: 327.83 1978.09; stroke-dashoffset: -2075.33; }
    91.67% { stroke-dasharray: 320.00 1985.92; stroke-dashoffset: -2113.76; }
    93.33% { stroke-dasharray: 327.83 1978.09; stroke-dashoffset: -2152.19; }
    95% { stroke-dasharray: 350.56 1955.36; stroke-dashoffset: -2190.62; }
    96.67% { stroke-dasharray: 385.95 1919.97; stroke-dashoffset: -2229.06; }
    98.33% { stroke-dasharray: 430.56 1875.36; stroke-dashoffset: -2267.49; }
    100% { stroke-dasharray: 480.00 1825.92; stroke-dashoffset: -2305.92; }
  }

  @keyframes movi-loader-crest {
    0% { stroke-dashoffset: -450.13; }
    1.667% { stroke-dashoffset: -603.02; }
    3.333% { stroke-dashoffset: -757.42; }
    5% { stroke-dashoffset: -901.98; }
    6.667% { stroke-dashoffset: -1026.30; }
    8.333% { stroke-dashoffset: -1121.99; }
    10% { stroke-dashoffset: -1183.43; }
    11.67% { stroke-dashoffset: -1208.37; }
    13.33% { stroke-dashoffset: -1198.14; }
    15% { stroke-dashoffset: -1157.50; }
    16.67% { stroke-dashoffset: -1094.19; }
    18.33% { stroke-dashoffset: -1018.16; }
    20% { stroke-dashoffset: -940.63; }
    21.67% { stroke-dashoffset: -872.93; }
    23.33% { stroke-dashoffset: -825.47; }
    25% { stroke-dashoffset: -806.65; }
    26.67% { stroke-dashoffset: -822.08; }
    28.33% { stroke-dashoffset: -873.99; }
    30% { stroke-dashoffset: -961.09; }
    31.67% { stroke-dashoffset: -1078.59; }
    33.33% { stroke-dashoffset: -1218.77; }
    35% { stroke-dashoffset: -1371.66; }
    36.67% { stroke-dashoffset: -1526.06; }
    38.33% { stroke-dashoffset: -1670.62; }
    40% { stroke-dashoffset: -1794.94; }
    41.67% { stroke-dashoffset: -1890.63; }
    43.33% { stroke-dashoffset: -1952.07; }
    45% { stroke-dashoffset: -1977.01; }
    46.67% { stroke-dashoffset: -1966.78; }
    48.33% { stroke-dashoffset: -1926.14; }
    50% { stroke-dashoffset: -1862.83; }
    51.67% { stroke-dashoffset: -1786.80; }
    53.33% { stroke-dashoffset: -1709.27; }
    55% { stroke-dashoffset: -1641.57; }
    56.67% { stroke-dashoffset: -1594.11; }
    58.33% { stroke-dashoffset: -1575.29; }
    60% { stroke-dashoffset: -1590.72; }
    61.67% { stroke-dashoffset: -1642.63; }
    63.33% { stroke-dashoffset: -1729.73; }
    65% { stroke-dashoffset: -1847.23; }
    66.67% { stroke-dashoffset: -1987.41; }
    68.33% { stroke-dashoffset: -2140.30; }
    70% { stroke-dashoffset: -2294.70; }
    71.67% { stroke-dashoffset: -2439.26; }
    73.33% { stroke-dashoffset: -2563.58; }
    75% { stroke-dashoffset: -2659.27; }
    76.67% { stroke-dashoffset: -2720.71; }
    78.33% { stroke-dashoffset: -2745.65; }
    80% { stroke-dashoffset: -2735.42; }
    81.67% { stroke-dashoffset: -2694.78; }
    83.33% { stroke-dashoffset: -2631.47; }
    85% { stroke-dashoffset: -2555.44; }
    86.67% { stroke-dashoffset: -2477.91; }
    88.33% { stroke-dashoffset: -2410.21; }
    90% { stroke-dashoffset: -2362.75; }
    91.67% { stroke-dashoffset: -2343.93; }
    93.33% { stroke-dashoffset: -2359.36; }
    95% { stroke-dashoffset: -2411.27; }
    96.67% { stroke-dashoffset: -2498.37; }
    98.33% { stroke-dashoffset: -2615.87; }
    100% { stroke-dashoffset: -2756.05; }
  }

  @keyframes movi-loader-neck {
    0% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -470.00; }
    1.667% { stroke-dasharray: 55.15 2250.77; stroke-dashoffset: -557.87; }
    3.333% { stroke-dasharray: 126.51 2179.41; stroke-dashoffset: -640.91; }
    5% { stroke-dasharray: 197.24 2108.68; stroke-dashoffset: -714.74; }
    6.667% { stroke-dasharray: 260.41 2045.51; stroke-dashoffset: -775.90; }
    8.333% { stroke-dasharray: 309.83 1996.09; stroke-dashoffset: -822.16; }
    10% { stroke-dasharray: 340.67 1965.25; stroke-dashoffset: -852.76; }
    11.67% { stroke-dasharray: 349.91 1956.01; stroke-dashoffset: -868.47; }
    13.33% { stroke-dasharray: 336.64 1969.28; stroke-dashoffset: -871.50; }
    15% { stroke-dasharray: 302.17 2003.75; stroke-dashoffset: -865.33; }
    16.67% { stroke-dasharray: 249.87 2056.05; stroke-dashoffset: -854.32; }
    18.33% { stroke-dasharray: 184.85 2121.07; stroke-dashoffset: -843.31; }
    20% { stroke-dasharray: 113.49 2192.43; stroke-dashoffset: -837.14; }
    21.67% { stroke-dasharray: 42.76 2263.16; stroke-dashoffset: -840.17; }
    23.33% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -855.88; }
    25% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -886.48; }
    26.67% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -932.74; }
    28.33% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -993.90; }
    30% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -1067.73; }
    31.67% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -1150.77; }
    33.33% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -1238.64; }
    35% { stroke-dasharray: 55.15 2250.77; stroke-dashoffset: -1326.51; }
    36.67% { stroke-dasharray: 126.51 2179.41; stroke-dashoffset: -1409.55; }
    38.33% { stroke-dasharray: 197.24 2108.68; stroke-dashoffset: -1483.38; }
    40% { stroke-dasharray: 260.41 2045.51; stroke-dashoffset: -1544.54; }
    41.67% { stroke-dasharray: 309.83 1996.09; stroke-dashoffset: -1590.80; }
    43.33% { stroke-dasharray: 340.67 1965.25; stroke-dashoffset: -1621.40; }
    45% { stroke-dasharray: 349.91 1956.01; stroke-dashoffset: -1637.11; }
    46.67% { stroke-dasharray: 336.64 1969.28; stroke-dashoffset: -1640.14; }
    48.33% { stroke-dasharray: 302.17 2003.75; stroke-dashoffset: -1633.97; }
    50% { stroke-dasharray: 249.87 2056.05; stroke-dashoffset: -1622.96; }
    51.67% { stroke-dasharray: 184.85 2121.07; stroke-dashoffset: -1611.95; }
    53.33% { stroke-dasharray: 113.49 2192.43; stroke-dashoffset: -1605.78; }
    55% { stroke-dasharray: 42.76 2263.16; stroke-dashoffset: -1608.81; }
    56.67% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -1624.52; }
    58.33% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -1655.12; }
    60% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -1701.38; }
    61.67% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -1762.54; }
    63.33% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -1836.37; }
    65% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -1919.41; }
    66.67% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -2007.28; }
    68.33% { stroke-dasharray: 55.15 2250.77; stroke-dashoffset: -2095.15; }
    70% { stroke-dasharray: 126.51 2179.41; stroke-dashoffset: -2178.19; }
    71.67% { stroke-dasharray: 197.24 2108.68; stroke-dashoffset: -2252.02; }
    73.33% { stroke-dasharray: 260.41 2045.51; stroke-dashoffset: -2313.18; }
    75% { stroke-dasharray: 309.83 1996.09; stroke-dashoffset: -2359.44; }
    76.67% { stroke-dasharray: 340.67 1965.25; stroke-dashoffset: -2390.04; }
    78.33% { stroke-dasharray: 349.91 1956.01; stroke-dashoffset: -2405.75; }
    80% { stroke-dasharray: 336.64 1969.28; stroke-dashoffset: -2408.78; }
    81.67% { stroke-dasharray: 302.17 2003.75; stroke-dashoffset: -2402.61; }
    83.33% { stroke-dasharray: 249.87 2056.05; stroke-dashoffset: -2391.60; }
    85% { stroke-dasharray: 184.85 2121.07; stroke-dashoffset: -2380.59; }
    86.67% { stroke-dasharray: 113.49 2192.43; stroke-dashoffset: -2374.42; }
    88.33% { stroke-dasharray: 42.76 2263.16; stroke-dashoffset: -2377.45; }
    90% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -2393.16; }
    91.67% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -2423.76; }
    93.33% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -2470.02; }
    95% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -2531.18; }
    96.67% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -2605.01; }
    98.33% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -2688.05; }
    100% { stroke-dasharray: 20.00 2285.92; stroke-dashoffset: -2775.92; }
  }

  @media (prefers-reduced-motion: reduce) {
    .movi-loader-container { animation: none; }
    .movi-loader-flow,
    .movi-loader-crest,
    .movi-loader-neck { animation: none; }
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
