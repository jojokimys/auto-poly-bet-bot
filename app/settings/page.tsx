import { Card, CardBody, CardHeader, Input, Button, Checkbox } from '@heroui/react';

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <h2 className="text-2xl font-bold">Settings</h2>
        </CardHeader>
        <CardBody>
          <p className="text-gray-600 dark:text-gray-400 mb-6">
            Configure your bot settings and preferences.
          </p>

          <div className="space-y-4">
            <Input
              type="password"
              label="API Key"
              placeholder="Enter your API key"
              variant="bordered"
            />

            <Input
              type="number"
              label="Max Bet Amount"
              placeholder="100"
              variant="bordered"
            />

            <Checkbox>
              Enable automatic betting
            </Checkbox>

            <Button color="primary" className="w-full">
              Save Settings
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
