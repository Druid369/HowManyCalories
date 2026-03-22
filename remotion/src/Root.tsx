import { Composition } from "remotion";
import { IntroSplash } from "./IntroSplash";

export const RemotionRoot = () => {
  return (
    <Composition
      id="IntroSplash"
      component={IntroSplash}
      durationInFrames={75}
      fps={30}
      width={430}
      height={932}
    />
  );
};
