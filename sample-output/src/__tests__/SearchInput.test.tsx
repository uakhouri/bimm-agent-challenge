import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MockedProvider } from "@apollo/client/testing";
import { describe, it, expect } from "vitest";
import { GET_CARS } from "@/graphql/queries";
import SearchInput from "@/components/SearchInput";
import { useState } from "react";
import type { Car } from "@/types";

const mockCars: Car[] = [
  {
    id: "1",
    make: "Toyota",
    model: "Camry",
    year: 2024,
    color: "Silver",
    mobile: "https://placehold.co/640x360",
    tablet: "https://placehold.co/1023x576",
    desktop: "https://placehold.co/1440x810",
  },
  {
    id: "2",
    make: "Honda",
    model: "Accord",
    year: 2023,
    color: "Blue",
    mobile: "https://placehold.co/640x360",
    tablet: "https://placehold.co/1023x576",
    desktop: "https://placehold.co/1440x810",
  },
  {
    id: "3",
    make: "Ford",
    model: "Mustang",
    year: 2022,
    color: "Red",
    mobile: "https://placehold.co/640x360",
    tablet: "https://placehold.co/1023x576",
    desktop: "https://placehold.co/1440x810",
  },
];

const mockCarsWithTypename = mockCars.map((car) => ({
  ...car,
  __typename: "Car" as const,
}));

const mocks = [
  {
    request: { query: GET_CARS },
    result: { data: { cars: mockCarsWithTypename } },
  },
];

function TestHarness() {
  const [searchTerm, setSearchTerm] = useState("");

  const filterCars = (cars: Car[]): Car[] => {
    if (!searchTerm) return cars;
    const lowerSearch = searchTerm.toLowerCase();
    return cars.filter((car) =>
      car.model.toLowerCase().includes(lowerSearch)
    );
  };

  const filteredCars = filterCars(mockCars);

  return (
    <div>
      <SearchInput value={searchTerm} onChange={setSearchTerm} />
      <ul>
        {filteredCars.map((car) => (
          <li key={car.id}>
            {car.year} {car.make} {car.model}
          </li>
        ))}
      </ul>
    </div>
  );
}

describe("SearchInput", () => {
  it("filters car list by model name", async () => {
    const user = userEvent.setup();
    render(
      <MockedProvider mocks={mocks}>
        <TestHarness />
      </MockedProvider>
    );

    expect(screen.getByText("2024 Toyota Camry")).toBeInTheDocument();
    expect(screen.getByText("2023 Honda Accord")).toBeInTheDocument();
    expect(screen.getByText("2022 Ford Mustang")).toBeInTheDocument();

    const searchInput = screen.getByLabelText("Search by model");
    await user.type(searchInput, "Camry");

    expect(screen.getByText("2024 Toyota Camry")).toBeInTheDocument();
    expect(screen.queryByText("2023 Honda Accord")).not.toBeInTheDocument();
    expect(screen.queryByText("2022 Ford Mustang")).not.toBeInTheDocument();
  });

  it("performs case-insensitive partial matching", async () => {
    const user = userEvent.setup();
    render(
      <MockedProvider mocks={mocks}>
        <TestHarness />
      </MockedProvider>
    );

    const searchInput = screen.getByLabelText("Search by model");
    await user.type(searchInput, "cam");

    expect(screen.getByText("2024 Toyota Camry")).toBeInTheDocument();
    expect(screen.queryByText("2023 Honda Accord")).not.toBeInTheDocument();
    expect(screen.queryByText("2022 Ford Mustang")).not.toBeInTheDocument();
  });

  it("shows all cars when search is cleared", async () => {
    const user = userEvent.setup();
    render(
      <MockedProvider mocks={mocks}>
        <TestHarness />
      </MockedProvider>
    );

    const searchInput = screen.getByLabelText("Search by model");
    await user.type(searchInput, "Camry");

    expect(screen.getByText("2024 Toyota Camry")).toBeInTheDocument();
    expect(screen.queryByText("2023 Honda Accord")).not.toBeInTheDocument();

    await user.clear(searchInput);

    expect(screen.getByText("2024 Toyota Camry")).toBeInTheDocument();
    expect(screen.getByText("2023 Honda Accord")).toBeInTheDocument();
    expect(screen.getByText("2022 Ford Mustang")).toBeInTheDocument();
  });
});
