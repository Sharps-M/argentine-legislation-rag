import { NextResponse, type NextRequest } from "next/server";

import { locales, pickLocale } from "@/i18n/config";

/**
 * Redirects requests without a locale prefix (`/`, `/about`) to the visitor's
 * preferred locale (`/es`, `/en/about`), based on the `Accept-Language` header.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const hasLocalePrefix = locales.some(
    (locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`),
  );
  if (hasLocalePrefix) return;

  const locale = pickLocale(request.headers.get("accept-language"));
  request.nextUrl.pathname = `/${locale}${pathname}`;

  return NextResponse.redirect(request.nextUrl);
}

export const config = {
  // Skip Next.js internals, API routes and files with an extension.
  matcher: ["/((?!_next|api|.*\\..*).*)"],
};
