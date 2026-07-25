export type UserStatus = 'active' | 'suspended'

export interface User {
  id: string
  email: string
  name: string
  instagramHandle: string | null
  status: UserStatus
  invitedBy: string | null
  createdAt: Date
}

export interface Invite {
  id: string
  code: string
  createdBy: string
  redeemedBy: string | null
  redeemedAt: Date | null
  expiresAt: Date
  createdAt: Date
}
