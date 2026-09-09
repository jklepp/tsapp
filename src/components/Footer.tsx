import { formatDate } from "../utils/date";

function Footer() {
  const year = new Date().getFullYear();
  const buildDate = import.meta.env.VITE_BUILD_DATE;

  return (
    <footer>
      <p>© {year} TS App</p>
      {buildDate && <p>Built {formatDate(new Date(buildDate))}</p>}
    </footer>
  );
}

export default Footer;
