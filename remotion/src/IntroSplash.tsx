import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Sequence,
  Easing,
} from "remotion";

const GREEN = "#34D399";
const BG = "#070B0F";
const T2 = "#8A9BB5";

const GlowDot: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({ frame, fps, config: { damping: 8, stiffness: 120 } });
  const glowPulse = interpolate(frame, [0, 20, 40], [0, 1, 0.6], {
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        width: 14,
        height: 14,
        borderRadius: "50%",
        background: GREEN,
        transform: `scale(${scale})`,
        boxShadow: `0 0 ${12 * glowPulse}px ${GREEN}, 0 0 ${30 * glowPulse}px rgba(52,211,153,0.3)`,
      }}
    />
  );
};

const LogoText: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const letters = ["H", "M", "C"];
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {letters.map((letter, i) => {
        const delay = i * 3;
        const s = spring({
          frame: frame - delay,
          fps,
          config: { damping: 12, stiffness: 180 },
        });
        const y = interpolate(s, [0, 1], [30, 0]);
        const opacity = interpolate(s, [0, 1], [0, 1]);
        const rotate = interpolate(s, [0, 0.5, 1], [-8, 2, 0]);

        return (
          <div
            key={i}
            style={{
              fontFamily: "'Syne', sans-serif",
              fontSize: 64,
              fontWeight: 800,
              color: "#EEF2F7",
              letterSpacing: -2,
              transform: `translateY(${y}px) rotate(${rotate}deg)`,
              opacity,
            }}
          >
            {letter}
          </div>
        );
      })}
    </div>
  );
};

const Tagline: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const text = "AI Calorie Scanner";

  const charsVisible = Math.floor(
    interpolate(frame, [0, 25], [0, text.length], {
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.quad),
    })
  );

  const cursorOpacity = frame % 16 < 10 ? 1 : 0;

  const fadeIn = spring({
    frame,
    fps,
    config: { damping: 200 },
  });

  return (
    <div
      style={{
        opacity: fadeIn,
        display: "flex",
        alignItems: "center",
        gap: 2,
      }}
    >
      <span
        style={{
          fontFamily: "'Figtree', sans-serif",
          fontSize: 14,
          fontWeight: 500,
          color: T2,
          letterSpacing: 3,
          textTransform: "uppercase",
        }}
      >
        {text.slice(0, charsVisible)}
      </span>
      <span
        style={{
          width: 1.5,
          height: 16,
          background: GREEN,
          opacity: charsVisible < text.length ? cursorOpacity : 0,
          marginLeft: 1,
        }}
      />
    </div>
  );
};

const ScanLine: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const y = interpolate(frame, [0, durationInFrames], [0, 100], {
    extrapolateRight: "clamp",
  });
  const opacity = interpolate(frame, [0, 5, durationInFrames - 10, durationInFrames], [0, 0.6, 0.6, 0], {
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        left: "10%",
        right: "10%",
        top: `${y}%`,
        height: 2,
        background: `linear-gradient(90deg, transparent, ${GREEN}, #22D3EE, ${GREEN}, transparent)`,
        boxShadow: `0 0 14px rgba(52,211,153,0.28)`,
        opacity,
      }}
    />
  );
};

const FadeOut: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.quad),
  });

  return (
    <AbsoluteFill style={{ background: BG, opacity }} />
  );
};

export const IntroSplash: React.FC = () => {
  const { fps, durationInFrames } = useVideoConfig();

  return (
    <AbsoluteFill
      style={{
        background: BG,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
      }}
    >
      {/* Ambient scan line */}
      <Sequence from={0} durationInFrames={durationInFrames} layout="none" premountFor={fps}>
        <ScanLine />
      </Sequence>

      {/* Glow dot */}
      <Sequence from={5} durationInFrames={durationInFrames} layout="none" premountFor={fps}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <GlowDot />
        </div>
      </Sequence>

      {/* Logo letters */}
      <Sequence from={8} durationInFrames={durationInFrames} layout="none" premountFor={fps}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <LogoText />
        </div>
      </Sequence>

      {/* Tagline typewriter */}
      <Sequence from={22} durationInFrames={durationInFrames} layout="none" premountFor={fps}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Tagline />
        </div>
      </Sequence>

      {/* Fade to black at the end */}
      <Sequence from={durationInFrames - 15} durationInFrames={15} premountFor={fps}>
        <FadeOut />
      </Sequence>
    </AbsoluteFill>
  );
};
