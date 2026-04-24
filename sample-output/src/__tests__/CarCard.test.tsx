import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import CarCard from "@/components/CarCard";
import type { Car } from "@/types";

const mockCar: Car = {
  id: "1",
  make: "Toyota",
  model: "Camry",
  year: 2024,
  color: "Silver",
  mobile: "https://placehold.co/640x360",
  tablet: "https://placehold.co/1023x576",
  desktop: "https://placehold.co/1440x810",
};

describe("CarCard component", () => {
  it("renders the car's make, model, year, and color", () => {
    render(<CarCard car={mockCar} viewportWidth={1024} />);

    expect(screen.getByText("2024 Toyota Camry")).toBeInTheDocument();
    expect(screen.getByText("Silver")).toBeInTheDocument();
  });

  it("verifies the heading format is 'YYYY Make Model'", () => {
    render(<CarCard car={mockCar} viewportWidth={1024} />);

    const heading = screen.getByRole("heading", { name: "2024 Toyota Camry" });
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveTextContent("2024 Toyota Camry");
  });

  it("verifies color is displayed", () => {
    render(<CarCard car={mockCar} viewportWidth={1024} />);

    expect(screen.getByText("Silver")).toBeInTheDocument();
  });
});
