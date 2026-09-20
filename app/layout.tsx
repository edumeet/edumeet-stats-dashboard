import type { Metadata } from 'next';
import { Roboto } from 'next/font/google';
import './globals.css';
import { ThemeInitializer } from '@/components/layout/ThemeInitializer';
import { TzInitializer } from '@/components/layout/TzInitializer';
import { ThemeToggle } from '@/components/layout/ThemeToggle';
import { TimezoneToggle } from '@/components/layout/TimezoneToggle';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { Banner } from '@/components/layout/Banner';
import { CompareFloatingButton } from '@/components/compare/CompareFloatingButton';
import { ChartCompareModal } from '@/components/compare/ChartCompareModal';
import { PoweredByObserveRTC } from '@/components/layout/PoweredByObserveRTC';
import styles from '@/App.module.css';

/**
 * Roboto, downloaded at build time and served from this origin.
 *
 * Roboto is what the edumeet client sets on <html>, so the dashboard shares its
 * face and reads as the same product.
 *
 * Deliberately not a `fonts.googleapis.com` stylesheet import: that makes every
 * viewer's browser call a third party on page load, which an egress-restricted
 * or air-gapped deployment blocks and which an operator hosting this themselves
 * did not sign up for. `next/font` fetches the face during `next build` and
 * emits it as a static asset, so a running container needs no outbound network
 * at all beyond the object storage it is configured with.
 *
 * `display: 'swap'` renders the fallback immediately rather than holding the
 * text blank while the face loads.
 */
const roboto = Roboto({
  subsets: ['latin'],
  weight: ['300', '400', '500', '700'],
  display: 'swap',
  variable: '--font-roboto',
  fallback: ['system-ui', 'sans-serif'],
});

export const metadata: Metadata = {
  title: 'edumeet Stats',
  description: 'edumeet WebRTC diagnostics dashboard, powered by ObserveRTC',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={roboto.variable} suppressHydrationWarning>
      <body>
        <ThemeInitializer />
        <TzInitializer />
        <ThemeToggle />
        <TimezoneToggle />
        <CompareFloatingButton />
        <ChartCompareModal />
        <div className={styles.layout}>
          <Breadcrumbs />
          <Banner />
          {children}
        </div>
        <PoweredByObserveRTC />
      </body>
    </html>
  );
}
