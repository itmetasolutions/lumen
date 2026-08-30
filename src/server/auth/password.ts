import 'server-only'
import bcrypt from 'bcryptjs'

const ROUNDS = 12

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS)
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash)
  } catch {
    return false
  }
}

/** Minimum viable policy; surfaced to the user rather than silently enforced. */
export function passwordProblems(pw: string): string[] {
  const problems: string[] = []
  if (pw.length < 10) problems.push('Must be at least 10 characters')
  if (!/[a-z]/.test(pw)) problems.push('Must contain a lowercase letter')
  if (!/[A-Z]/.test(pw)) problems.push('Must contain an uppercase letter')
  if (!/[0-9]/.test(pw)) problems.push('Must contain a number')
  return problems
}
