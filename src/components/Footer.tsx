function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer>
      <p>© {year} TS App</p>
    </footer>
  );
}

export default Footer;
