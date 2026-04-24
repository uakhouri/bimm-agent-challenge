import { useState, FormEvent } from "react";
import { Box, TextField, Button, Alert, Typography } from "@mui/material";
import { useAddCar } from "@/hooks/useCars";

export default function AddCarForm() {
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [year, setYear] = useState("");
  const [color, setColor] = useState("");
  const [yearError, setYearError] = useState("");

  const [addCar, { loading, error }] = useAddCar();

  const validateYear = (value: string): boolean => {
    if (!value) {
      setYearError("Year is required");
      return false;
    }
    const numValue = parseInt(value, 10);
    if (isNaN(numValue) || value.length !== 4 || numValue < 1000 || numValue > 9999) {
      setYearError("Year must be a valid four-digit number");
      return false;
    }
    setYearError("");
    return true;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (!make || !model || !color) {
      return;
    }

    if (!validateYear(year)) {
      return;
    }

    try {
      await addCar({
        variables: {
          make,
          model,
          year: parseInt(year, 10),
          color,
        },
      });

      setMake("");
      setModel("");
      setYear("");
      setColor("");
      setYearError("");
    } catch {
      // Error is handled by Apollo's error state
    }
  };

  const handleYearChange = (value: string) => {
    setYear(value);
    if (yearError) {
      validateYear(value);
    }
  };

  return (
    <Box component="form" onSubmit={handleSubmit} sx={{ mt: 4 }}>
      <Typography variant="h5" sx={{ mb: 2 }}>
        Add New Car
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error.message}
        </Alert>
      )}

      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <TextField
          label="Make"
          value={make}
          onChange={(e) => setMake(e.target.value)}
          required
          fullWidth
        />

        <TextField
          label="Model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          required
          fullWidth
        />

        <TextField
          label="Year"
          value={year}
          onChange={(e) => handleYearChange(e.target.value)}
          required
          fullWidth
          type="number"
          error={!!yearError}
          helperText={yearError}
          inputProps={{
            min: 1000,
            max: 9999,
            step: 1,
          }}
        />

        <TextField
          label="Color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          required
          fullWidth
        />

        <Button
          type="submit"
          variant="contained"
          disabled={loading}
          sx={{ alignSelf: "flex-start" }}
        >
          {loading ? "Adding..." : "Add Car"}
        </Button>
      </Box>
    </Box>
  );
}
