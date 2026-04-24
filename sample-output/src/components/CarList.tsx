import { useState, useEffect } from "react";
import { Box, Grid, CircularProgress, Alert } from "@mui/material";
import { useCars } from "@/hooks/useCars";
import CarCard from "@/components/CarCard";
import SearchInput from "@/components/SearchInput";
import SortSelector, { type SortOption } from "@/components/SortSelector";
import type { Car } from "@/types";

export default function CarList() {
  const { data, loading, error } = useCars();
  const [searchTerm, setSearchTerm] = useState("");
  const [sortOption, setSortOption] = useState<SortOption>("year");
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);

  useEffect(() => {
    const handleResize = () => {
      setViewportWidth(window.innerWidth);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" p={4}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Box p={2}>
        <Alert severity="error">{error.message}</Alert>
      </Box>
    );
  }

  const filterCars = (cars: Car[]): Car[] => {
    if (!searchTerm) return cars;
    const lowerSearch = searchTerm.toLowerCase();
    return cars.filter((car) =>
      car.model.toLowerCase().includes(lowerSearch)
    );
  };

  const sortCars = (cars: Car[]): Car[] => {
    const sorted = [...cars];
    if (sortOption === "year") {
      sorted.sort((a, b) => b.year - a.year);
    } else {
      sorted.sort((a, b) => a.make.localeCompare(b.make));
    }
    return sorted;
  };

  const filteredAndSortedCars = sortCars(filterCars(data?.cars || []));

  return (
    <Box>
      <Box display="flex" gap={2} mb={3}>
        <Box flex={1}>
          <SearchInput value={searchTerm} onChange={setSearchTerm} />
        </Box>
        <Box flex={1}>
          <SortSelector value={sortOption} onChange={setSortOption} />
        </Box>
      </Box>

      <Grid container spacing={2}>
        {filteredAndSortedCars.map((car) => (
          <Grid item xs={12} sm={6} md={4} key={car.id}>
            <CarCard car={car} viewportWidth={viewportWidth} />
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}
