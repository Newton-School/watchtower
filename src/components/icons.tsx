import type { SVGProps } from 'react';
import {
  Activity,
  Gauge,
  LayoutDashboard,
  Lightbulb,
  Menu,
  Play,
  Rocket,
  Settings,
  Terminal,
  Users,
  X,
} from 'lucide-react';

type IconProps = SVGProps<SVGSVGElement>;

const ICON_SIZE = 18;
const ICON_STROKE = 1.5;

function BaseIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    />
  );
}

export function WatchtowerIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M12 3 4.5 6v4.5c0 4.9 2.9 8.7 7.5 10.5 4.6-1.8 7.5-5.6 7.5-10.5V6L12 3Z" />
      <path d="M9 10h6" />
      <path d="M8.5 14h7" />
    </BaseIcon>
  );
}

export function OverviewIcon() {
  return <LayoutDashboard size={ICON_SIZE} strokeWidth={ICON_STROKE} />;
}

export function RunsIcon() {
  return <Play size={ICON_SIZE} strokeWidth={ICON_STROKE} />;
}

export function LaunchpadIcon() {
  return <Rocket size={ICON_SIZE} strokeWidth={ICON_STROKE} />;
}

export function IntelligenceIcon() {
  return <Lightbulb size={ICON_SIZE} strokeWidth={ICON_STROKE} />;
}

export function PerformanceIcon() {
  return <Activity size={ICON_SIZE} strokeWidth={ICON_STROKE} />;
}

export function UxMetricsIcon() {
  return <Gauge size={ICON_SIZE} strokeWidth={ICON_STROKE} />;
}

export function DiagnosticsIcon() {
  return <Terminal size={ICON_SIZE} strokeWidth={ICON_STROKE} />;
}

export function DossiersIcon() {
  return <Users size={ICON_SIZE} strokeWidth={ICON_STROKE} />;
}

export function SettingsIcon() {
  return <Settings size={ICON_SIZE} strokeWidth={ICON_STROKE} />;
}

export function MenuIcon() {
  return <Menu size={ICON_SIZE} strokeWidth={ICON_STROKE} />;
}

export function CloseIcon() {
  return <X size={ICON_SIZE} strokeWidth={ICON_STROKE} />;
}
