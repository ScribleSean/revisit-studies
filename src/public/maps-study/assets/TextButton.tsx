import { Button } from '@mantine/core';
import { IconX } from '@tabler/icons-react';

interface TextButtonProps {
  name: string;
  onClick: () => void;
}

export function TextButton({ name, onClick }: TextButtonProps) {
  return (
    <Button
      color="blue"
      rightSection={<IconX size={14} />}
      pr={8}
      mr={20}
      onClick={onClick}
      size="sm"
    >
      {name}
    </Button>
  );
}
