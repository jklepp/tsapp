import { render, screen } from "@testing-library/react";
import Footer from "./Footer";

test("renders the current year in the footer", () => {
  render(<Footer />);

  const year = new Date().getFullYear();

  expect(screen.getByText(`© ${year} TS App`)).toBeInTheDocument();
});
