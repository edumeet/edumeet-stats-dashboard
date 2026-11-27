'use client';
import { useEffect, useState } from 'react';
import { SIGN_OUT_URL, fetchSessionUser } from '../../api/client.ts';
import styles from './SessionBadge.module.css';

/**
 * Who is signed in, and the way out.
 *
 * Nothing is rendered when the sign-in is switched off, where there is nobody
 * to name and nothing to sign out of.
 *
 * Signing out is a form post, not a link: a link could be followed by any page
 * that names it, and the server accepts the request from this origin only.
 */
export function SessionBadge() {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchSessionUser(controller.signal).then((user) => setName(user?.name ?? null));
    return () => controller.abort();
  }, []);

  if (!name) return null;

  return (
    <form className={styles.badge} method="post" action={SIGN_OUT_URL}>
      <span className={styles.name} title={name}>{name}</span>
      <button className={styles.signOut} type="submit">Sign out</button>
    </form>
  );
}
