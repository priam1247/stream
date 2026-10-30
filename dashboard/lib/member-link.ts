/** Normalize Malawi numbers without silently accepting letters or foreign codes. */
export function normalizeMalawiNumber(input: string): { number?: string; error?: string } {
  const compact = input.trim().replace(/[\s+()\-]/g, '');
  if (!compact) return { error: 'Enter your WhatsApp phone number.' };
  if (!/^\d+$/.test(compact)) return { error: 'Use digits, spaces, + or - in your phone number.' };
  let national = compact.replace(/^0+/, '');
  if (national.startsWith('265')) national = national.slice(3).replace(/^0+/, '');
  if (!/^\d{9}$/.test(national)) {
    return { error: 'Enter a Malawi number with 9 digits after +265, for example 0991234567.' };
  }
  return { number: `265${national}` };
}

export function formatCountdown(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function maskMemberNumber(number: string): string {
  if (number.length < 7) return 'Number unavailable';
  return `+${number.slice(0, 3)} ••• •• ${number.slice(-4)}`;
}
