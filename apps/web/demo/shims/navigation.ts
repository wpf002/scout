/** `next/navigation`, backed by the demo's hash router. */
import { caseIdFromPath, navigate, usePath } from "../router.js";

export function useParams<T = Record<string, string>>(): T {
  return { id: caseIdFromPath(usePath()) } as T;
}

export function useRouter() {
  return {
    push: navigate,
    replace: navigate,
    back: () => window.history.back(),
    refresh: () => undefined,
    prefetch: () => undefined,
  };
}

export function usePathname(): string {
  return usePath();
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams();
}
