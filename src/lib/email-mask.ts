// An email address shown to someone who needs to tell accounts apart but has no
// business holding the address: the first character of the local part and the
// domain ("c…@example.com"). Zero imports, so client code may use it too.
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return email ? `${email.slice(0, 1)}…` : "";
  return `${email.slice(0, 1)}…${email.slice(at)}`;
}
