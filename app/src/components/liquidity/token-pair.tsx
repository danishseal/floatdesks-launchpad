import styles from "./liquidity.module.css";

function tokenSymbol(token: string) {
  if (token.includes("USD")) return "$";
  if (token.toLowerCase().includes("eth")) return "Ξ";
  return token.slice(0, 1).toUpperCase();
}

export function TokenPair({ tokenA, tokenB }: { tokenA: string; tokenB: string }) {
  return (
    <span className={styles.tokenPair} aria-hidden="true">
      <span className={styles.tokenMark}>{tokenSymbol(tokenA)}</span>
      <span className={styles.tokenMark}>{tokenSymbol(tokenB)}</span>
    </span>
  );
}
