import type { ComponentType, SVGProps } from "react";
import {
  ArrowLeft as PixelArrowLeft,
  ArrowRight as PixelArrowRight,
  Blocks,
  Bell,
  Box,
  Brush,
  Castle,
  Check as PixelCheck,
  CheckboxOn,
  Clock as PixelClock,
  Close,
  Cloud,
  Coffee as PixelCoffee,
  ColorsSwatch,
  Database as PixelDatabase,
  Download,
  Earth,
  File as PixelFile,
  FileText as PixelFileText,
  Filter,
  Folder,
  Gamepad,
  Globe,
  Grid2x22,
  Home,
  Image as PixelImage,
  InfoBox,
  ListBox,
  Loader,
  Login,
  Minus as PixelMinus,
  MoreVertical,
  Package,
  Play as PixelPlay,
  Plus as PixelPlus,
  Repeat,
  Search,
  Server,
  Settings2,
  SettingsCog2,
  Shield,
  SpeedFast,
  Square as PixelSquare,
  Star as PixelStar,
  Sword as PixelSword,
  Terminal,
  ToolCase,
  TreePine,
  Trash as PixelTrash,
  Upload,
  User,
  WarningDiamond,
} from "pixelarticons/react";

export interface PixelIconProps extends Omit<SVGProps<SVGSVGElement>, "height" | "width"> {
  size?: number | string;
  /** Kept for drop-in compatibility while SLH migrates from stroke icons. */
  weight?: string;
}

type PixelSource = ComponentType<SVGProps<SVGSVGElement>>;

function pixelIcon(Source: PixelSource) {
  return function PixelIcon({ size = 24, weight: _weight, ...props }: PixelIconProps) {
    return (
      <Source
        {...props}
        width={size}
        height={size}
        shapeRendering="crispEdges"
        aria-hidden={props["aria-label"] ? undefined : true}
      />
    );
  };
}

export const ArrowClockwise = pixelIcon(Repeat);
export const ArrowLeft = pixelIcon(PixelArrowLeft);
export const ArrowRight = pixelIcon(PixelArrowRight);
export const ArrowsClockwise = pixelIcon(Repeat);
export const BellSimple = pixelIcon(Bell);
export const Check = pixelIcon(PixelCheck);
export const CheckCircle = pixelIcon(CheckboxOn);
export const Clock = pixelIcon(PixelClock);
export const CloudArrowDown = pixelIcon(Download);
export const CloudSlash = pixelIcon(Cloud);
export const Code = pixelIcon(Terminal);
export const Coffee = pixelIcon(PixelCoffee);
export const Compass = pixelIcon(Search);
export const Cube = pixelIcon(Box);
export const Database = pixelIcon(PixelDatabase);
export const DownloadSimple = pixelIcon(Download);
export const Export = pixelIcon(Upload);
export const File = pixelIcon(PixelFile);
export const FileText = pixelIcon(PixelFileText);
export const FolderOpen = pixelIcon(Folder);
export const Funnel = pixelIcon(Filter);
export const GameController = pixelIcon(Gamepad);
export const Gauge = pixelIcon(SpeedFast);
export const GearSix = pixelIcon(SettingsCog2);
export const GlobeHemisphereWest = pixelIcon(Globe);
export const HardDrives = pixelIcon(Server);
export const House = pixelIcon(Home);
export const Image = pixelIcon(PixelImage);
export const Info = pixelIcon(InfoBox);
export const ListBullets = pixelIcon(ListBox);
export const MagnifyingGlass = pixelIcon(Search);
export const Minus = pixelIcon(PixelMinus);
export const DotsThreeVertical = pixelIcon(MoreVertical);
export const Palette = pixelIcon(ColorsSwatch);
export const Play = pixelIcon(PixelPlay);
export const Plus = pixelIcon(PixelPlus);
export const PuzzlePiece = pixelIcon(Blocks);
export const ShieldCheck = pixelIcon(Shield);
export const SignIn = pixelIcon(Login);
export const SlidersHorizontal = pixelIcon(Settings2);
export const SpinnerGap = pixelIcon(Loader);
export const Square = pixelIcon(PixelSquare);
export const SquaresFour = pixelIcon(Grid2x22);
export const Stack = pixelIcon(Package);
export const Star = pixelIcon(PixelStar);
export const Sword = pixelIcon(PixelSword);
export const Trash = pixelIcon(PixelTrash);
export const UserCircle = pixelIcon(User);
export const WarningCircle = pixelIcon(WarningDiamond);
export const Wrench = pixelIcon(ToolCase);
export const Tree = pixelIcon(TreePine);
export const Worlds = pixelIcon(Castle);
export const X = pixelIcon(Close);
export const BrushIcon = pixelIcon(Brush);
export const EarthIcon = pixelIcon(Earth);
