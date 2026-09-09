import { render, screen } from "@testing-library/react";
import Header from "./Header";

test("renders the header title", () => {
  render(<Header title="TS App" />);

  expect(screen.getByText("TS App")).toBeInTheDocument();
});
