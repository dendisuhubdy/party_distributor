import { db } from '@/lib/db/client'
import { PostgresMembershipRepository } from '@/lib/db/repositories/membership'
import type { MembershipDeps } from '@/lib/domain/membership/ports'

export const membershipDeps: MembershipDeps = {
  repository: new PostgresMembershipRepository(db),
  now: () => new Date(),
}
