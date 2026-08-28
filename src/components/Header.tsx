type HeaderProps = {
  title: string;
};

function Header({ title }: HeaderProps) {
  return (
    <header>
      <h2>{title}</h2>
    </header>
  );
}

export default Header;
