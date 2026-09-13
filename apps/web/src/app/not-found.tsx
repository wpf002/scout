import Link from "next/link";

/**
 * Scout is one page, so this is only reached by a mistyped URL. It still needs
 * to exist: without it the default Next page appears, which is unstyled and
 * says nothing about what the operator was looking for.
 */
export default function NotFound() {
  return (
    <div className="fault">
      <h1>No such page</h1>
      <p>Scout is a single surface. Everything is on the map.</p>
      <div className="fault-actions">
        <Link href="/">Back to the Map</Link>
      </div>
    </div>
  );
}
