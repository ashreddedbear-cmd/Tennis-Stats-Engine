export function TennisMatrixLogo() {
  return (
    <svg
      viewBox="0 0 48 48"
      width="100%"
      height="100%"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <clipPath id="tmClip">
          <circle cx="24" cy="24" r="23.5" />
        </clipPath>
        <radialGradient id="tmBase" cx="40%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#071307" />
          <stop offset="100%" stopColor="#010401" />
        </radialGradient>
        <filter id="tmSeamGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="0.7" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Base dark circle */}
      <circle cx="24" cy="24" r="24" fill="url(#tmBase)" />

      {/* Clipped content */}
      <g clipPath="url(#tmClip)">

        {/* Matrix rain columns — vertical dash segments, vary opacity for depth */}
        {/* Column far-left */}
        <line x1="8" y1="4"  x2="8" y2="44" stroke="#00ff41" strokeWidth="0.6"
          strokeDasharray="2.5 3.5 1.5 5 3 4 2 6" opacity="0.13" />
        {/* Column left-center */}
        <line x1="16" y1="2"  x2="16" y2="46" stroke="#00ff41" strokeWidth="0.6"
          strokeDasharray="1.5 4 3 3.5 2 5.5 1.5 4" opacity="0.1" />
        {/* Column center */}
        <line x1="24" y1="3"  x2="24" y2="45" stroke="#00ff41" strokeWidth="0.6"
          strokeDasharray="3 3 2 5 1.5 4.5 2.5 3" opacity="0.1" />
        {/* Column right-center */}
        <line x1="32" y1="2"  x2="32" y2="46" stroke="#00ff41" strokeWidth="0.6"
          strokeDasharray="2 4.5 3 3 1.5 5 2 4" opacity="0.1" />
        {/* Column far-right */}
        <line x1="40" y1="4"  x2="40" y2="44" stroke="#00ff41" strokeWidth="0.6"
          strokeDasharray="1.5 5 2.5 3 3 4 1.5 5.5" opacity="0.13" />

        {/* ── PCB-trace tennis seam — TOP (angular, circuit-board style) ── */}
        <path
          d="M 1 24 L 5 24 L 5 19 L 10 19 L 10 13 L 18 13 L 18 19 L 30 19 L 30 13 L 38 13 L 38 19 L 43 19 L 43 24 L 47 24"
          fill="none"
          stroke="#00ff41"
          strokeWidth="1.7"
          strokeLinejoin="miter"
          strokeLinecap="butt"
          opacity="0.92"
          filter="url(#tmSeamGlow)"
        />

        {/* ── PCB-trace tennis seam — BOTTOM (mirror) ── */}
        <path
          d="M 1 24 L 5 24 L 5 29 L 10 29 L 10 35 L 18 35 L 18 29 L 30 29 L 30 35 L 38 35 L 38 29 L 43 29 L 43 24 L 47 24"
          fill="none"
          stroke="#00ff41"
          strokeWidth="1.7"
          strokeLinejoin="miter"
          strokeLinecap="butt"
          opacity="0.92"
          filter="url(#tmSeamGlow)"
        />

        {/* ── PCB nodes: square pads at every inflection point — TOP ── */}
        {/* left outer bend */}
        <rect x="3.5" y="17.5" width="3" height="3" fill="#00ff41" opacity="0.95" />
        {/* left-peak down */}
        <rect x="8.5" y="11.5" width="3" height="3" fill="#00ff41" opacity="0.95" />
        {/* inner valley - left */}
        <rect x="16.5" y="11.5" width="3" height="3" fill="#00ff41" opacity="0.95" />
        <rect x="16.5" y="17.5" width="3" height="3" fill="#00ff41" opacity="0.95" />
        {/* inner valley - right */}
        <rect x="28.5" y="17.5" width="3" height="3" fill="#00ff41" opacity="0.95" />
        <rect x="28.5" y="11.5" width="3" height="3" fill="#00ff41" opacity="0.95" />
        {/* right-peak down */}
        <rect x="36.5" y="11.5" width="3" height="3" fill="#00ff41" opacity="0.95" />
        {/* right outer bend */}
        <rect x="36.5" y="17.5" width="3" height="3" fill="#00ff41" opacity="0.95" />
        <rect x="41.5" y="17.5" width="3" height="3" fill="#00ff41" opacity="0.95" />

        {/* ── PCB nodes: square pads — BOTTOM ── */}
        <rect x="3.5" y="27.5" width="3" height="3" fill="#00ff41" opacity="0.95" />
        <rect x="8.5" y="33.5" width="3" height="3" fill="#00ff41" opacity="0.95" />
        <rect x="16.5" y="33.5" width="3" height="3" fill="#00ff41" opacity="0.95" />
        <rect x="16.5" y="27.5" width="3" height="3" fill="#00ff41" opacity="0.95" />
        <rect x="28.5" y="27.5" width="3" height="3" fill="#00ff41" opacity="0.95" />
        <rect x="28.5" y="33.5" width="3" height="3" fill="#00ff41" opacity="0.95" />
        <rect x="36.5" y="33.5" width="3" height="3" fill="#00ff41" opacity="0.95" />
        <rect x="36.5" y="27.5" width="3" height="3" fill="#00ff41" opacity="0.95" />
        <rect x="41.5" y="27.5" width="3" height="3" fill="#00ff41" opacity="0.95" />

      </g>

      {/* Outer ring */}
      <circle cx="24" cy="24" r="23" fill="none" stroke="#00ff41" strokeWidth="0.9" opacity="0.65" />

      {/* Center targeting reticle */}
      <line x1="20.5" y1="24" x2="27.5" y2="24" stroke="#00ff41" strokeWidth="0.9" opacity="0.85" />
      <line x1="24" y1="20.5" x2="24" y2="27.5" stroke="#00ff41" strokeWidth="0.9" opacity="0.85" />
      {/* Center node — bright square */}
      <rect x="22.5" y="22.5" width="3" height="3" fill="#00ff41" opacity="1" />
    </svg>
  )
}
