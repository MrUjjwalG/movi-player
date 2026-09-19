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
        <mask id="movi-loader-flow-mask" maskUnits="userSpaceOnUse" x="350" y="80" width="870" height="870">
          <path class="movi-loader-flow" d="M441.05 183.62 Q441.05 143.62 476.72 161.73 L1139.97 498.51 Q1170.28 513.9 1139.97 529.29 L476.72 866.07 Q441.05 884.18 441.05 844.18 Z"/>
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
  }

  .movi-loader-flow {
    fill: none;
    stroke: #fff;
    stroke-width: 360;
    stroke-linecap: round;
    animation: movi-loader-flow 1.8s linear infinite;
  }

  .movi-loader-track { opacity: .32; }

  @keyframes movi-loader-in {
    from { opacity: 0; transform: scale(.84); }
    to { opacity: 1; transform: none; }
  }

  /* Use actual path units: WebKit does not consistently apply pathLength to
     dashes. One full perimeter per cycle also keeps the loop seam invisible.
     The flow path is the thin band's centre line, which sits further out than
     the fat band's did, so the perimeter is 2305.92 rather than 1883.12 and
     the light's length grew in step (318-1078 instead of 260-880) to cover
     the same share of the loop. */
  @keyframes movi-loader-flow {
    0% { stroke-dasharray: 318 1987.92; stroke-dashoffset: 0; }
    50% { stroke-dasharray: 1078 1227.92; stroke-dashoffset: -772.96; }
    100% { stroke-dasharray: 318 1987.92; stroke-dashoffset: -2305.92; }
  }

  @media (prefers-reduced-motion: reduce) {
    .movi-loader-container { animation: none; }
    .movi-loader-flow { animation: none; }
    .movi-loader-track { opacity: 1; }
    .movi-loader-highlight { display: none; }
  }

  @container movi-host (max-width: 720px) {
    .movi-loader-container { width: 52px; height: 52px; }
  }
`;
