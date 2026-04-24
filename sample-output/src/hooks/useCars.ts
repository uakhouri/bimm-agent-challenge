import { useQuery, useMutation } from "@apollo/client";
import { GET_CARS, ADD_CAR } from "@/graphql/queries";
import type { Car } from "@/types";

interface GetCarsData {
  cars: Car[];
}

interface AddCarData {
  addCar: Car;
}

interface AddCarVariables {
  make: string;
  model: string;
  year: number;
  color: string;
}

export function useCars() {
  return useQuery<GetCarsData>(GET_CARS);
}

export function useAddCar() {
  return useMutation<AddCarData, AddCarVariables>(ADD_CAR, {
    refetchQueries: [{ query: GET_CARS }],
  });
}
