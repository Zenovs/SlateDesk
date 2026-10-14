import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { LoaderCircle, type LucideIcon } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface CommonProps {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
  /** Only the icon is shown; the (string) children become aria-label and tooltip. */
  iconOnly?: boolean;
  /** Full width. */
  block?: boolean;
  children?: ReactNode;
}

const ICON_SIZE: Record<Size, number> = { sm: 16, md: 18, lg: 20 };

function classes({ variant = 'secondary', size = 'md', iconOnly, block }: CommonProps, extra?: string): string {
  return ['r-btn', `r-btn-${variant}`, `r-btn-${size}`, iconOnly && 'r-btn-icon', block && 'r-btn-block', extra]
    .filter(Boolean)
    .join(' ');
}

const iconLabel = (iconOnly: boolean | undefined, children: ReactNode): string | undefined =>
  iconOnly && typeof children === 'string' ? children : undefined;

export interface ButtonProps extends CommonProps, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Shows a spinner instead of the icon and blocks clicks. */
  busy?: boolean;
}

/** Button with variants (primary/secondary/ghost/danger), sizes, optional icon and busy spinner; ≥ 44 px touch target. */
export function Button({
  variant,
  size = 'md',
  icon: Icon,
  iconOnly,
  block,
  busy = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const label = iconLabel(iconOnly, children);
  return (
    <button
      {...rest}
      type={type}
      className={classes({ variant, size, iconOnly, block }, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      aria-label={label ?? rest['aria-label']}
      title={label ?? rest.title}
    >
      {busy ? (
        <LoaderCircle className="r-spin" size={ICON_SIZE[size]} aria-hidden="true" />
      ) : (
        Icon && <Icon size={ICON_SIZE[size]} aria-hidden="true" />
      )}
      {!iconOnly && children !== undefined && <span className="r-btn-label">{children}</span>}
    </button>
  );
}

export interface LinkButtonProps extends CommonProps, Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children'> {
  href: string;
}

/** Link styled like Button (e.g. `href={href('layout')}`). */
export function LinkButton({ variant, size = 'md', icon: Icon, iconOnly, block, className, children, ...rest }: LinkButtonProps) {
  const label = iconLabel(iconOnly, children);
  return (
    <a
      {...rest}
      className={classes({ variant, size, iconOnly, block }, className)}
      aria-label={label ?? rest['aria-label']}
      title={label ?? rest.title}
    >
      {Icon && <Icon size={ICON_SIZE[size]} aria-hidden="true" />}
      {!iconOnly && children !== undefined && <span className="r-btn-label">{children}</span>}
    </a>
  );
}
