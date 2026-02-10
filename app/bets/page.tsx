import { Card, CardBody, CardHeader } from '@heroui/react';

export default function BetsPage() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <h2 className="text-2xl font-bold">Bets</h2>
        </CardHeader>
        <CardBody>
          <p className="text-gray-600 dark:text-gray-400">
            View and manage your bets here.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    ID
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Market
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Amount
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                <tr>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400 text-center" colSpan={4}>
                    No bets found
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
