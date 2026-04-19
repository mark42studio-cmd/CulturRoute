// Auth logic has been migrated to proxy.ts (Next.js 16+ convention).
// This file is kept as a no-op to satisfy the compiler while the project
// is updated; it can be deleted once proxy.ts is confirmed working.
import { NextRequest, NextResponse } from 'next/server'

export function middleware(_req: NextRequest) {
  return NextResponse.next()
}

export const config = {
  matcher: [],
}
