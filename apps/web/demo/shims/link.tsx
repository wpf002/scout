/**
 * `next/link`, replaced by an anchor that drives the demo's hash router.
 *
 * The application components are imported unmodified, so the substitution has
 * to happen at the module boundary rather than in the components themselves —
 * a demo that required edits to the real pages would stop reflecting them.
 */
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { navigate } from "../router.js";

export default function Link({
  href,
  children,
  ...rest
}: { href: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={`#${href}`}
      onClick={(event) => {
        event.preventDefault();
        navigate(href);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
