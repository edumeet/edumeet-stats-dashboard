import styles from './PoweredByObserveRTC.module.css';

/**
 * "Powered by ObserveRTC" credit, pinned to the bottom-left of every page.
 *
 * This dashboard is a joint effort between two open-source projects: edumeet
 * owns the product and the look, ObserveRTC owns the client monitor and the
 * sample format that every chart here is drawn from. The badge says so without
 * competing with the data.
 *
 * A plain <img> rather than next/image: the asset is a static SVG served from
 * /public at a fixed 18px, so there is nothing for the image optimiser to do,
 * and next/image would need `dangerouslyAllowSVG` turned on to handle it.
 */
export function PoweredByObserveRTC() {
  return (
    <a
      className={styles.badge}
      href="https://observertc.org/"
      target="_blank"
      rel="noopener noreferrer"
      title="Powered by ObserveRTC"
    >
      <img className={styles.mark} src="/observertc-logo.svg" alt="" aria-hidden="true" />
      <span className={styles.prefix}>Powered by</span>
      <span className={styles.name}>ObserveRTC</span>
    </a>
  );
}
