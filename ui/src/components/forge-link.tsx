import type { ReactNode } from "react";
import { linkParts } from "../factory-view.ts";

// A reference to an issue or pull request in the forge: a link in a new tab when the server gave an address, plain text without one.
export function ForgeLink({
  href,
  className,
  children,
}: {
  href: string | null | undefined;
  className?: string;
  children: ReactNode;
}) {
  if (!href) return <span className={className}>{children}</span>;
  return (
    <a className={className ? className + " forge-link" : "forge-link"} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

// A text with its '#n' numbers as links (see linkParts): "waiting for #54, #55" with both numbers linked when the server has their addresses.
export function LinkedText({ text, links }: { text: string; links?: Record<string, string> }) {
  return (
    <>
      {linkParts(text, links).map((part, index) =>
        part.href ? (
          <ForgeLink key={index} href={part.href}>{part.text}</ForgeLink>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
