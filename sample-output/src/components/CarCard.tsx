import { Card, CardContent, CardMedia, Typography } from "@mui/material";
import type { Car } from "@/types";

interface CarCardProps {
  car: Car;
  viewportWidth: number;
}

export default function CarCard({ car, viewportWidth }: CarCardProps) {
  const getImageUrl = () => {
    if (viewportWidth <= 640) {
      return car.mobile;
    }
    if (viewportWidth <= 1023) {
      return car.tablet;
    }
    return car.desktop;
  };

  return (
    <Card>
      <CardMedia
        component="img"
        image={getImageUrl()}
        alt={`${car.year} ${car.make} ${car.model}`}
      />
      <CardContent>
        <Typography variant="h6">
          {car.year} {car.make} {car.model}
        </Typography>
        <Typography color="text.secondary">{car.color}</Typography>
      </CardContent>
    </Card>
  );
}
