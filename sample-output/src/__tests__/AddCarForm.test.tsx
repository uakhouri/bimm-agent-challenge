import { render, screen, waitFor } from "@testing-library/react";
import { MockedProvider } from "@apollo/client/testing";
import { describe, it, expect } from "vitest";
import userEvent from "@testing-library/user-event";
import { ADD_CAR } from "@/graphql/queries";
import AddCarForm from "@/components/AddCarForm";

const mockAddCarResponse = {
  id: "new-car-id",
  make: "Honda",
  model: "Accord",
  year: 2023,
  color: "Blue",
  mobile: "https://placehold.co/640x360",
  tablet: "https://placehold.co/1023x576",
  desktop: "https://placehold.co/1440x810",
  __typename: "Car" as const,
};

const mocks = [
  {
    request: {
      query: ADD_CAR,
      variables: {
        make: "Honda",
        model: "Accord",
        year: 2023,
        color: "Blue",
      },
    },
    result: {
      data: {
        addCar: mockAddCarResponse,
      },
    },
  },
];

describe("AddCarForm", () => {
  it("submits the form with entered values", async () => {
    const user = userEvent.setup();

    render(
      <MockedProvider mocks={mocks}>
        <AddCarForm />
      </MockedProvider>
    );

    const makeInput = screen.getByLabelText(/make/i);
    const modelInput = screen.getByLabelText(/model/i);
    const yearInput = screen.getByLabelText(/year/i);
    const colorInput = screen.getByLabelText(/color/i);
    const submitButton = screen.getByRole("button", { name: /add car/i });

    await user.type(makeInput, "Honda");
    await user.type(modelInput, "Accord");
    await user.type(yearInput, "2023");
    await user.type(colorInput, "Blue");

    await user.click(submitButton);

    await waitFor(() => {
      expect(makeInput).toHaveValue("");
      expect(modelInput).toHaveValue("");
      expect(yearInput).toHaveValue(null);
      expect(colorInput).toHaveValue("");
    });
  });
});
