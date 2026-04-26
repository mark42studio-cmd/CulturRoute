import { NextRequest, NextResponse } from 'next/server'

// 帳號密碼從環境變數讀取，請在 cultur-route/.env.local 設定：
//   ADMIN_USERNAME=your_username
//   ADMIN_PASSWORD=your_password
const ADMIN_USER = process.env.ADMIN_USERNAME ?? 'admin'
const ADMIN_PASS = process.env.ADMIN_PASSWORD ?? 'taitung500'

export function middleware(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? ''

  if (authHeader.startsWith('Basic ')) {
    try {
      const encoded = authHeader.slice(6)
      const decoded = atob(encoded)               // Edge Runtime 使用 atob，不用 Buffer
      const colonIdx = decoded.indexOf(':')
      const user = decoded.slice(0, colonIdx)
      const pass = decoded.slice(colonIdx + 1)    // 密碼本身可含冒號，故從第一個冒號切分

      if (user === ADMIN_USER && pass === ADMIN_PASS) {
        return NextResponse.next()
      }
    } catch {
      // Base64 解碼失敗，視為無效憑證
    }
  }

  return new NextResponse('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="CulturRoute Admin"' },
  })
}

export const config = {
  matcher: ['/admin/:path*'],
}
