import { render, screen } from "@testing-library/react";
import Footer from "./Footer";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("renders the current year in the footer", () => {
  render(<Footer />);

  const year = new Date().getFullYear();

  expect(screen.getByText(`© ${year} TS App`)).toBeInTheDocument();
});

test("renders the formatted build date when VITE_BUILD_DATE is set", () => {
  vi.stubEnv("VITE_BUILD_DATE", "2026-09-09T12:00:00");

  render(<Footer />);

  expect(screen.getByText("Built 2026-09-09")).toBeInTheDocument();
});

test("renders no build date when VITE_BUILD_DATE is missing", () => {
  render(<Footer />);

  expect(screen.queryByText(/^Built /)).not.toBeInTheDocument();
});
