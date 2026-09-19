import { controlToken } from "./config";
import { timingSafeEqualText } from "./hmac";

/**
 * Mutating control-plane routes.
 * Token unset = local showcase (open). Token set = Bearer required.
 */
export function authorizeControl(header: string | undefined): boolean {
  const token = controlToken();
  if (!token) {
    return true;
  }
  if (!header) {
    return false;
  }
  return timingSafeEqualText(header, `Bearer ${token}`);
}
