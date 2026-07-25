import { handlers } from '@/lib/auth'

// NextAuth returns its route handlers grouped under `handlers`; they are not
// individually named exports of lib/auth, so they have to be destructured here.
export const { GET, POST } = handlers
